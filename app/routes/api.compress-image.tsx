import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { QUERY_SHOP_NAME } from "../lib/constants";
import { processSingleImage } from "../lib/optimization-engine";
import { fetchAllProducts, getProductImages } from "../lib/shopify-media";
import type { ShopifyProduct, ShopifyMediaImage } from "../lib/types";

/**
 * API endpoint to compress a single image by its media GID.
 * Used by the Image Browser for per-image compression.
 *
 * POST /api/compress-image
 * Body: { imageId, productId }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const { imageId, productId } = body;

  if (!imageId || !productId) {
    return json({ success: false, error: "imageId and productId are required" }, { status: 400 });
  }

  try {
    // Check if already optimized
    const existing = await db.imageOptimization.findUnique({
      where: { shop_imageId: { shop, imageId } },
    });

    if (existing && existing.status === "completed") {
      return json({ success: false, error: "Image is already optimized" }, { status: 400 });
    }

    // Also check if this is a WebP replacement
    const existingAsWebp = await db.imageOptimization.findFirst({
      where: { shop, newMediaId: imageId, status: "completed" },
    });

    if (existingAsWebp) {
      return json({ success: false, error: "Image is already an optimized WebP version" }, { status: 400 });
    }

    // Fetch the specific product to get its media
    const QUERY_SINGLE_PRODUCT = `#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          vendor
          productType
          media(first: 50) {
            edges {
              node {
                ... on MediaImage {
                  id
                  image { url altText width height }
                  mediaContentType
                }
              }
            }
          }
        }
      }
    `;

    const productResponse = await admin.graphql(QUERY_SINGLE_PRODUCT, {
      variables: { id: productId },
    });
    const productData = await productResponse.json();
    const product = (productData as any).data?.product as ShopifyProduct | null;

    if (!product) {
      return json({ success: false, error: "Product not found" }, { status: 404 });
    }

    // Find the specific image
    const images = getProductImages(product);
    const targetImage = images.find((img) => img.id === imageId);

    if (!targetImage) {
      return json({ success: false, error: "Image not found on product" }, { status: 404 });
    }

    const imageIndex = images.indexOf(targetImage);

    // Get shop name for SEO templates
    const shopResponse = await admin.graphql(QUERY_SHOP_NAME);
    const shopData = await shopResponse.json();
    const shopName = (shopData as any).data?.shop?.name || shop;

    // Get SEO settings
    const seoSettings = await db.seoSettings.findUnique({ where: { shop } });

    // Create a lightweight job record for tracking
    const job = await db.optimizationJob.create({
      data: { shop, status: "running", totalImages: 1 },
    });

    // Process the single image
    const progress = { processedCount: 0, errorCount: 0, skippedCount: 0, totalSaved: 0 };

    try {
      await processSingleImage({
        admin,
        shop,
        product,
        media: targetImage,
        imageIndex,
        shopName,
        seoSettings,
        jobId: job.id,
        progress,
      });

      // Mark job completed
      await db.optimizationJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          processedCount: progress.processedCount,
          totalSaved: progress.totalSaved,
        },
      });

      // Fetch the updated optimization record
      const updatedOpt = await db.imageOptimization.findUnique({
        where: { shop_imageId: { shop, imageId } },
      });

      return json({
        success: true,
        optimization: updatedOpt
          ? {
              id: updatedOpt.id,
              status: updatedOpt.status,
              fileSize: updatedOpt.fileSize,
              webpFileSize: updatedOpt.webpFileSize,
              savings: updatedOpt.fileSize && updatedOpt.webpFileSize
                ? ((updatedOpt.fileSize - updatedOpt.webpFileSize) / updatedOpt.fileSize * 100).toFixed(1)
                : null,
              newMediaId: updatedOpt.newMediaId,
              webpUrl: updatedOpt.webpUrl,
            }
          : null,
      });
    } catch (processError) {
      // Mark job as failed
      await db.optimizationJob.update({
        where: { id: job.id },
        data: { status: "failed", errorCount: 1 },
      });

      console.error(`[api.compress-image] Failed to process ${imageId}:`, processError);
      return json({
        success: false,
        error: processError instanceof Error ? processError.message : "Failed to compress image",
      }, { status: 500 });
    }
  } catch (error) {
    console.error("[api.compress-image] Error:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    }, { status: 500 });
  }
};
