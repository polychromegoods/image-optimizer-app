import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

/**
 * API endpoint to get WebP image URL by image ID
 * This can be called from the storefront theme to get optimized images
 * 
 * Example: GET /api/webp-image/gid://shopify/ProductImage/123456789
 */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const imageId = params.imageId;
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!imageId || !shop) {
    return json({ error: "Missing imageId or shop parameter" }, { status: 400 });
  }

  try {
    const optimization = await db.imageOptimization.findUnique({
      where: {
        shop_imageId: {
          shop,
          imageId: `gid://shopify/ProductImage/${imageId}`,
        },
      },
    });

    if (!optimization || optimization.status !== "completed") {
      return json({ 
        error: "Image not optimized",
        originalUrl: null,
        webpUrl: null,
      }, { status: 404 });
    }

    return json({
      imageId: optimization.imageId,
      originalUrl: optimization.originalUrl,
      webpUrl: optimization.webpUrl,
      fileSize: optimization.fileSize,
      webpFileSize: optimization.webpFileSize,
      savings: optimization.fileSize && optimization.webpFileSize
        ? ((optimization.fileSize - optimization.webpFileSize) / optimization.fileSize) * 100
        : 0,
    });
  } catch (error) {
    console.error("Error fetching WebP image:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
