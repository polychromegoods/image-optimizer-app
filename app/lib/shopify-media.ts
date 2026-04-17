import type { ShopifyAdmin, StagedUploadTarget, ShopifyProduct, ShopifyMediaImage } from "./types";
import {
  MUTATION_STAGED_UPLOADS_CREATE,
  MUTATION_FILE_CREATE,
  MUTATION_PRODUCT_DELETE_MEDIA,
  MUTATION_PRODUCT_CREATE_MEDIA,
  QUERY_PRODUCTS_WITH_MEDIA,
  QUERY_PRODUCT_MEDIA_DETAILS,
  MUTATION_PRODUCT_REORDER_MEDIA,
  MUTATION_VARIANT_APPEND_MEDIA,
  MUTATION_VARIANT_DETACH_MEDIA,
  PRODUCTS_PER_PAGE,
} from "./constants";

// ─── Staged Upload Helpers ─────────────────────────────────────────────────────

/**
 * Create a staged upload target in Shopify for a given file.
 */
async function createStagedUpload(
  admin: ShopifyAdmin,
  resource: "FILE" | "IMAGE",
  filename: string,
  mimeType: string,
): Promise<StagedUploadTarget> {
  const response = await admin.graphql(MUTATION_STAGED_UPLOADS_CREATE, {
    variables: {
      input: [{ resource, filename, mimeType, httpMethod: "POST" }],
    },
  });

  const data = await response.json();
  const target = data.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const errors = data.data?.stagedUploadsCreate?.userErrors;

  if (!target) {
    const errorMsg = errors?.map((e: { message: string }) => e.message).join(", ") || "Unknown error";
    throw new Error(`Failed to create staged upload for ${filename}: ${errorMsg}`);
  }

  return target;
}

/**
 * Upload a buffer to a staged upload target.
 */
async function uploadToStagedTarget(
  target: StagedUploadTarget,
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<void> {
  const formData = new FormData();
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(target.url, { method: "POST", body: formData });
  if (!response.ok) {
    throw new Error(`Upload to staged target failed (${response.status}): ${response.statusText}`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload a backup of the original image to Shopify Files (permanent storage).
 * Returns the resourceUrl that can be used to restore the image later.
 */
export async function uploadBackupToFiles(
  admin: ShopifyAdmin,
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const target = await createStagedUpload(admin, "FILE", filename, mimeType);
  await uploadToStagedTarget(target, buffer, filename, mimeType);

  // Register the file in Shopify's file storage and verify it succeeded
  const fileCreateResponse = await admin.graphql(MUTATION_FILE_CREATE, {
    variables: {
      files: [
        {
          alt: "Backup original image",
          contentType: "IMAGE",
          originalSource: target.resourceUrl,
        },
      ],
    },
  });

  const fileCreateData = await fileCreateResponse.json();
  const fileCreateErrors = (fileCreateData as any).data?.fileCreate?.userErrors;
  if (fileCreateErrors?.length > 0) {
    const errorMsg = fileCreateErrors.map((e: { message: string }) => e.message).join(", ");
    throw new Error(`Backup fileCreate failed for ${filename}: ${errorMsg}`);
  }

  // Try to extract the permanent Shopify Files URL from the response
  const createdFile = (fileCreateData as any).data?.fileCreate?.files?.[0];
  const permanentUrl = createdFile?.image?.url || createdFile?.url || null;

  // Return the permanent URL if available, otherwise fall back to resourceUrl
  // The resourceUrl from staged uploads may expire, but the permanent URL won't
  if (permanentUrl) {
    console.log(`[Backup] Stored permanent URL for ${filename}: ${permanentUrl}`);
    return permanentUrl;
  }

  console.warn(`[Backup] Could not extract permanent URL for ${filename}, using resourceUrl as fallback`);
  return target.resourceUrl;
}

/**
 * Upload a WebP image for use as product media.
 * Returns the resourceUrl needed for productCreateMedia.
 */
export async function uploadWebpImage(
  admin: ShopifyAdmin,
  webpBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const fullFilename = `${fileName}.webp`;
  const target = await createStagedUpload(admin, "IMAGE", fullFilename, "image/webp");
  await uploadToStagedTarget(target, webpBuffer, fullFilename, "image/webp");
  return target.resourceUrl;
}

/**
 * Delete media from a product.
 */
export async function deleteProductMedia(
  admin: ShopifyAdmin,
  productId: string,
  mediaIds: string[],
): Promise<void> {
  const response = await admin.graphql(MUTATION_PRODUCT_DELETE_MEDIA, {
    variables: { productId, mediaIds },
  });

  const data = await response.json();
  const errors = data.data?.productDeleteMedia?.mediaUserErrors;
  if (errors?.length > 0) {
    console.error("Media delete errors:", errors);
  }
}

/**
 * Create new media on a product from a source URL.
 * Returns the new media ID and image URL.
 */
export async function createProductMedia(
  admin: ShopifyAdmin,
  productId: string,
  sourceUrl: string,
  altText: string,
): Promise<{ mediaId: string | null; imageUrl: string | null }> {
  const response = await admin.graphql(MUTATION_PRODUCT_CREATE_MEDIA, {
    variables: {
      productId,
      media: [
        {
          alt: altText,
          mediaContentType: "IMAGE",
          originalSource: sourceUrl,
        },
      ],
    },
  });

  const data = await response.json();
  const errors = data.data?.productCreateMedia?.mediaUserErrors;

  if (errors?.length > 0) {
    const errorMsg = errors.map((e: { message: string }) => e.message).join(", ");
    throw new Error(`Failed to create product media: ${errorMsg}`);
  }

  const newMedia = data.data?.productCreateMedia?.media?.[0];
  const mediaId = newMedia?.id || null;
  const imageUrl = newMedia?.image?.url || null;

  // SAFETY: If Shopify returned no media ID, the image was not actually attached
  // to the product. Treat this as a failure to prevent silent data loss.
  if (!mediaId) {
    console.error(`[createProductMedia] Shopify returned no media ID for product ${productId}. Response:`, JSON.stringify(data.data?.productCreateMedia));
    throw new Error(`Product media creation returned no media ID for product ${productId}. The image may not have been attached.`);
  }

  return { mediaId, imageUrl };
}

// ─── Position & Variant Preservation Helpers ─────────────────────────────────

export interface MediaPositionInfo {
  /** Zero-based position of this media in the product's media list */
  position: number;
  /** Variant IDs that reference this media */
  variantIds: string[];
}

/**
 * Query a product to get the position of a specific media item and which variants reference it.
 */
export async function getMediaPositionAndVariants(
  admin: ShopifyAdmin,
  productId: string,
  mediaId: string,
): Promise<MediaPositionInfo> {
  const response = await admin.graphql(QUERY_PRODUCT_MEDIA_DETAILS, {
    variables: { productId },
  });
  const data = await response.json();
  const product = (data as any).data?.product;

  // Find position (media is returned in position order)
  const mediaEdges = product?.media?.edges || [];
  let position = -1;
  for (let i = 0; i < mediaEdges.length; i++) {
    if (mediaEdges[i].node?.id === mediaId) {
      position = i;
      break;
    }
  }

  // Find which variants reference this media
  const variantIds: string[] = [];
  const variantEdges = product?.variants?.edges || [];
  for (const variantEdge of variantEdges) {
    const variant = variantEdge.node;
    const variantMediaEdges = variant?.media?.edges || [];
    for (const vmEdge of variantMediaEdges) {
      if (vmEdge.node?.id === mediaId) {
        variantIds.push(variant.id);
        break;
      }
    }
  }

  console.log(`[getMediaPositionAndVariants] Media ${mediaId} on product ${productId}: position=${position}, variants=${variantIds.length}`);
  return { position, variantIds };
}

/**
 * Reorder a media item to a specific position on a product.
 */
export async function reorderProductMedia(
  admin: ShopifyAdmin,
  productId: string,
  mediaId: string,
  newPosition: number,
): Promise<void> {
  console.log(`[reorderProductMedia] Moving media ${mediaId} to position ${newPosition} on product ${productId}`);
  const response = await admin.graphql(MUTATION_PRODUCT_REORDER_MEDIA, {
    variables: {
      id: productId,
      moves: [{ id: mediaId, newPosition: String(newPosition) }],
    },
  });
  const data = await response.json();
  const errors = (data as any).data?.productReorderMedia?.mediaUserErrors;
  if (errors?.length > 0) {
    console.error(`[reorderProductMedia] Errors:`, errors);
    throw new Error(`Failed to reorder media: ${errors.map((e: any) => e.message).join(", ")}`);
  }
}

/**
 * Assign media to variants (append). This associates the media with the variant
 * so it shows as the variant's image.
 */
export async function assignMediaToVariants(
  admin: ShopifyAdmin,
  productId: string,
  mediaId: string,
  variantIds: string[],
): Promise<void> {
  if (variantIds.length === 0) return;

  console.log(`[assignMediaToVariants] Assigning media ${mediaId} to ${variantIds.length} variant(s) on product ${productId}`);
  const variantMedia = variantIds.map((variantId) => ({
    variantId,
    mediaIds: [mediaId],
  }));

  const response = await admin.graphql(MUTATION_VARIANT_APPEND_MEDIA, {
    variables: { productId, variantMedia },
  });
  const data = await response.json();
  const errors = (data as any).data?.productVariantAppendMedia?.userErrors;
  if (errors?.length > 0) {
    console.error(`[assignMediaToVariants] Errors:`, errors);
    // Non-fatal — log but don't throw
  }
}

/**
 * Detach media from variants before deleting the media.
 */
export async function detachMediaFromVariants(
  admin: ShopifyAdmin,
  productId: string,
  mediaId: string,
  variantIds: string[],
): Promise<void> {
  if (variantIds.length === 0) return;

  console.log(`[detachMediaFromVariants] Detaching media ${mediaId} from ${variantIds.length} variant(s) on product ${productId}`);
  const variantMedia = variantIds.map((variantId) => ({
    variantId,
    mediaIds: [mediaId],
  }));

  const response = await admin.graphql(MUTATION_VARIANT_DETACH_MEDIA, {
    variables: { productId, variantMedia },
  });
  const data = await response.json();
  const errors = (data as any).data?.productVariantDetachMedia?.userErrors;
  if (errors?.length > 0) {
    console.error(`[detachMediaFromVariants] Errors:`, errors);
    // Non-fatal — log but don't throw
  }
}

// ─── Product Parsing Helpers ───────────────────────────────────────────────────

/**
 * Extract image-type media nodes from a product.
 */
export function getProductImages(product: ShopifyProduct): ShopifyMediaImage[] {
  return (
    product.media?.edges
      ?.map((e) => e.node)
      ?.filter((m) => m.mediaContentType === "IMAGE") || []
  );
}

/**
 * Parse the products array from a Shopify GraphQL response.
 * Returns both products and pagination info.
 */
export function parseProductsResponse(data: Record<string, unknown>): {
  products: ShopifyProduct[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} {
  const productsData = data as {
    data?: {
      products?: {
        edges?: Array<{ node: ShopifyProduct }>;
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };
  return {
    products: productsData.data?.products?.edges?.map((e) => e.node) || [],
    pageInfo: productsData.data?.products?.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

/**
 * Fetch ALL products from the store using cursor-based pagination.
 * This ensures stores with >250 products have all images detected.
 */
export async function fetchAllProducts(admin: ShopifyAdmin): Promise<ShopifyProduct[]> {
  const allProducts: ShopifyProduct[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageNum = 0;

  while (hasNextPage) {
    pageNum++;
    const variables: Record<string, unknown> = { first: PRODUCTS_PER_PAGE };
    if (cursor) variables.after = cursor;

    console.log(`[fetchAllProducts] Fetching page ${pageNum}, cursor: ${cursor || "(start)"}`);

    const response = await admin.graphql(QUERY_PRODUCTS_WITH_MEDIA, { variables });
    const data = await response.json();
    const { products, pageInfo } = parseProductsResponse(data);

    allProducts.push(...products);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;

    console.log(`[fetchAllProducts] Page ${pageNum}: ${products.length} products (total so far: ${allProducts.length}, hasNextPage: ${hasNextPage})`);
  }

  console.log(`[fetchAllProducts] Complete: ${allProducts.length} total products across ${pageNum} page(s)`);
  return allProducts;
}
