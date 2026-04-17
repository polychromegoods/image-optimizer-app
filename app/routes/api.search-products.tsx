import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { MAX_MEDIA_PER_PRODUCT } from "../lib/constants";
import db from "../db.server";

/**
 * API endpoint to search products by title query.
 * Used by the Image Browser for product search/autocomplete.
 *
 * GET /api/search-products?q=<query>&cursor=<cursor>
 */

const SEARCH_PRODUCTS_QUERY = `#graphql
  query searchProducts($query: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          featuredMedia {
            ... on MediaImage {
              image { url }
            }
          }
          media(first: ${MAX_MEDIA_PER_PRODUCT}) {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ALL_PRODUCTS_QUERY = `#graphql
  query allProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          featuredMedia {
            ... on MediaImage {
              image { url }
            }
          }
          media(first: ${MAX_MEDIA_PER_PRODUCT}) {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";
  const cursor = url.searchParams.get("cursor") || null;
  const perPage = 25;

  try {
    const variables: Record<string, unknown> = { first: perPage };
    if (cursor) variables.after = cursor;

    let response;
    if (query.trim()) {
      variables.query = `title:*${query}*`;
      response = await admin.graphql(SEARCH_PRODUCTS_QUERY, { variables });
    } else {
      response = await admin.graphql(ALL_PRODUCTS_QUERY, { variables });
    }

    const data = await response.json();
    const productsData = (data as any).data?.products;
    const products = productsData?.edges?.map((e: any) => {
      const node = e.node;
      const images = node.media?.edges
        ?.map((me: any) => me.node)
        ?.filter((m: any) => m.mediaContentType === "IMAGE") || [];
      const featuredUrl = node.featuredMedia?.image?.url || images[0]?.image?.url || null;

      return {
        id: node.id,
        title: node.title,
        handle: node.handle,
        vendor: node.vendor,
        productType: node.productType,
        featuredImageUrl: featuredUrl,
        imageCount: images.length,
        images: images.map((img: any) => ({
          id: img.id,
          url: img.image.url,
          altText: img.image.altText,
          width: img.image.width,
          height: img.image.height,
        })),
      };
    }) || [];

    const pageInfo = productsData?.pageInfo || { hasNextPage: false, endCursor: null };

    // Fetch optimization status for all images in the results
    const allImageIds = products.flatMap((p: any) => p.images.map((img: any) => img.id));

    const optimizations = await db.imageOptimization.findMany({
      where: {
        shop: session.shop,
        OR: [
          { imageId: { in: allImageIds } },
          { newMediaId: { in: allImageIds } },
        ],
      },
      select: {
        id: true,
        imageId: true,
        newMediaId: true,
        status: true,
        fileSize: true,
        webpFileSize: true,
        webpUrl: true,
      },
    });

    // Build lookup maps
    const statusByImageId = new Map<string, any>();
    for (const opt of optimizations) {
      statusByImageId.set(opt.imageId, opt);
      if (opt.newMediaId) {
        statusByImageId.set(opt.newMediaId, { ...opt, isWebpVersion: true });
      }
    }

    // Annotate images with optimization status
    for (const product of products) {
      for (const img of product.images) {
        const opt = statusByImageId.get(img.id);
        if (opt) {
          img.optimizationStatus = opt.status;
          img.optimizationId = opt.id;
          img.isWebpVersion = opt.isWebpVersion || false;
          img.originalSize = opt.fileSize;
          img.webpSize = opt.webpFileSize;
          img.savings = opt.fileSize && opt.webpFileSize
            ? ((opt.fileSize - opt.webpFileSize) / opt.fileSize * 100).toFixed(1)
            : null;
        } else {
          img.optimizationStatus = "new";
          img.optimizationId = null;
          img.isWebpVersion = false;
        }
      }
    }

    return json({ products, pageInfo, shop: session.shop });
  } catch (error) {
    console.error("[api.search-products] Error:", error);
    return json({ products: [], pageInfo: { hasNextPage: false, endCursor: null }, error: "Failed to search products" }, { status: 500 });
  }
};
