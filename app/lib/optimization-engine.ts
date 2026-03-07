import sharp from "sharp";
import type {
  ShopifyAdmin,
  ShopifyProduct,
  ShopifyMediaImage,
  SeoSettingsRecord,
} from "./types";
import { WEBP_QUALITY } from "./constants";
import { applyTemplate, makeFileName, buildTemplateVariables, getMimeType, getExtensionFromUrl, extractIdFromGid } from "./templates";
import { uploadBackupToFiles, uploadWebpImage, deleteProductMedia, createProductMedia, getProductImages } from "./shopify-media";
import db from "../db.server";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface OptimizationProgress {
  processedCount: number;
  errorCount: number;
  skippedCount: number;
  totalSaved: number;
}

interface ProcessSingleImageParams {
  admin: ShopifyAdmin;
  shop: string;
  product: ShopifyProduct;
  media: ShopifyMediaImage;
  imageIndex: number;
  shopName: string;
  seoSettings: SeoSettingsRecord | null;
  jobId: string;
  progress: OptimizationProgress;
}

// ─── Single Image Processing ───────────────────────────────────────────────────

/**
 * Process a single image: backup original, convert to WebP, replace on product.
 * Updates the database records and job progress as it goes.
 *
 * BUG-003 FIX: If WebP is larger than original, skip the conversion and mark as completed
 * with a note that the original was kept.
 */
export async function processSingleImage({
  admin,
  shop,
  product,
  media,
  imageIndex,
  shopName,
  seoSettings,
  jobId,
  progress,
}: ProcessSingleImageParams): Promise<void> {
  const productId = product.id;

  // Update job with current image name
  await db.optimizationJob.update({
    where: { id: jobId },
    data: {
      currentImage: `${product.title || "Unknown"} (image ${imageIndex + 1})`,
      processedCount: progress.processedCount,
      errorCount: progress.errorCount,
      skippedCount: progress.skippedCount,
      totalSaved: progress.totalSaved,
    },
  });

  // Mark as processing
  await db.imageOptimization.upsert({
    where: { shop_imageId: { shop, imageId: media.id } },
    create: {
      shop,
      productId,
      imageId: media.id,
      originalUrl: media.image.url,
      originalGid: media.id,
      originalAlt: media.image.altText || "",
      status: "processing",
    },
    update: {
      status: "processing",
      originalAlt: media.image.altText || "",
    },
  });

  // Build SEO names
  const templateVars = buildTemplateVariables(product, shopName, imageIndex);
  let altText = media.image.altText || product.title || "";
  let fileName = `optimized-${extractIdFromGid(media.id)}`;

  if (seoSettings?.autoApplyOnOptimize) {
    if (seoSettings.altTextTemplate) {
      altText = applyTemplate(seoSettings.altTextTemplate, templateVars);
    }
    if (seoSettings.fileNameTemplate) {
      fileName = makeFileName(seoSettings.fileNameTemplate, templateVars);
    }
  }

  // Step 1: Fetch the original image
  const imageResponse = await fetch(media.image.url);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch original image (${imageResponse.status})`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const originalSize = imageBuffer.length;

  // Step 2: Convert to WebP
  const webpBuffer = await sharp(imageBuffer)
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  const webpSize = webpBuffer.length;

  // BUG-003 FIX: If WebP is larger than or equal to original, skip the replacement
  if (webpSize >= originalSize) {
    console.log(`Skipping ${media.id}: WebP (${webpSize}) >= original (${originalSize})`);
    progress.skippedCount++;
    progress.processedCount++;

    await db.imageOptimization.update({
      where: { shop_imageId: { shop, imageId: media.id } },
      data: {
        fileSize: originalSize,
        webpFileSize: originalSize, // Keep original size
        status: "completed",
        // Store original URL as both original and webp since we're keeping the original
        webpUrl: media.image.url,
        webpGid: media.id,
        altTextUpdated: false,
      },
    });

    await db.optimizationJob.update({
      where: { id: jobId },
      data: {
        processedCount: progress.processedCount,
        skippedCount: progress.skippedCount,
      },
    });
    return;
  }

  // Step 3: Backup original to Shopify Files
  const extension = getExtensionFromUrl(media.image.url);
  const backupFilename = `backup-${extractIdFromGid(media.id)}.${extension}`;
  const backupMimeType = getMimeType(extension);

  const backupUrl = await uploadBackupToFiles(admin, imageBuffer, backupFilename, backupMimeType);

  // Step 4: Upload WebP
  const webpResourceUrl = await uploadWebpImage(admin, webpBuffer, fileName);

  // Step 5: Delete original product media
  await deleteProductMedia(admin, productId, [media.id]);

  // Step 6: Create new product media with WebP
  const { mediaId: newMediaId, imageUrl: newImageUrl } = await createProductMedia(
    admin,
    productId,
    webpResourceUrl,
    altText,
  );

  // Step 7: Update database record
  const savings = originalSize - webpSize;
  progress.totalSaved += savings;
  progress.processedCount++;

  await db.imageOptimization.update({
    where: { shop_imageId: { shop, imageId: media.id } },
    data: {
      webpUrl: newImageUrl || webpResourceUrl,
      webpGid: newMediaId,
      backupUrl,
      fileSize: originalSize,
      webpFileSize: webpSize,
      status: "completed",
      altTextUpdated: seoSettings?.autoApplyOnOptimize ?? false,
    },
  });

  // BUG-001 FIX: Also track the NEW media ID so we can recognize it on refresh
  // Store a mapping from the new webp media ID to the original record
  if (newMediaId) {
    try {
      await db.imageOptimization.upsert({
        where: { shop_imageId: { shop, imageId: newMediaId } },
        create: {
          shop,
          productId,
          imageId: newMediaId,
          originalUrl: media.image.url,
          originalGid: media.id,
          originalAlt: media.image.altText || "",
          webpUrl: newImageUrl || webpResourceUrl,
          webpGid: newMediaId,
          backupUrl,
          fileSize: originalSize,
          webpFileSize: webpSize,
          status: "completed",
          altTextUpdated: seoSettings?.autoApplyOnOptimize ?? false,
        },
        update: {
          // Already tracked, don't overwrite
        },
      });
    } catch (e) {
      // Non-critical: just means we already have this record
      console.log(`Note: Could not create tracking record for new media ${newMediaId}:`, e);
    }
  }

  // Update job progress
  await db.optimizationJob.update({
    where: { id: jobId },
    data: {
      processedCount: progress.processedCount,
      errorCount: progress.errorCount,
      totalSaved: progress.totalSaved,
    },
  });
}

// ─── Batch Processing ──────────────────────────────────────────────────────────

interface RunOptimizationParams {
  admin: ShopifyAdmin;
  shop: string;
  products: ShopifyProduct[];
  shopName: string;
  seoSettings: SeoSettingsRecord | null;
  jobId: string;
  targetImageId: string | null;
  isRetry: boolean;
}

/**
 * Run the optimization loop across all products and images.
 * Checks for cancellation before each image.
 * Returns final progress counts.
 *
 * BUG-001 FIX: Skip images that already have a "completed" record in the DB,
 * matching by EITHER the original media ID or the new WebP media ID.
 *
 * BUG-005 FIX: Add a small delay between images to avoid overwhelming
 * Shopify API and database connections.
 */
export async function runOptimizationLoop({
  admin,
  shop,
  products,
  shopName,
  seoSettings,
  jobId,
  targetImageId,
  isRetry,
}: RunOptimizationParams): Promise<OptimizationProgress & { cancelled: boolean }> {
  const progress: OptimizationProgress = {
    processedCount: 0,
    errorCount: 0,
    skippedCount: 0,
    totalSaved: 0,
  };

  for (const product of products) {
    const mediaImages = getProductImages(product);

    for (let i = 0; i < mediaImages.length; i++) {
      const media = mediaImages[i];

      // Skip if targeting a specific image
      if (targetImageId && media.id !== targetImageId) continue;

      // Check for cancellation
      const currentJob = await db.optimizationJob.findUnique({
        where: { id: jobId },
      });
      if (currentJob?.cancelled) {
        await db.optimizationJob.update({
          where: { id: jobId },
          data: {
            status: "cancelled",
            processedCount: progress.processedCount,
            errorCount: progress.errorCount,
            skippedCount: progress.skippedCount,
            totalSaved: progress.totalSaved,
            currentImage: null,
          },
        });
        return { ...progress, cancelled: true };
      }

      // BUG-001 FIX: Skip already-completed images (unless retrying)
      // Check by media ID — this covers both original IDs and new WebP IDs
      if (!isRetry && !targetImageId) {
        const existing = await db.imageOptimization.findUnique({
          where: { shop_imageId: { shop, imageId: media.id } },
        });
        if (existing && (existing.status === "completed" || existing.status === "processing")) {
          progress.skippedCount++;
          await db.optimizationJob.update({
            where: { id: jobId },
            data: { skippedCount: progress.skippedCount },
          });
          continue;
        }
      }

      // Process the image
      try {
        await processSingleImage({
          admin,
          shop,
          product,
          media,
          imageIndex: i,
          shopName,
          seoSettings,
          jobId,
          progress,
        });
      } catch (error) {
        console.error(`Error processing image ${media.id}:`, error);
        progress.errorCount++;

        await db.imageOptimization.upsert({
          where: { shop_imageId: { shop, imageId: media.id } },
          create: {
            shop,
            productId: product.id,
            imageId: media.id,
            originalUrl: media.image?.url || "",
            originalGid: media.id,
            originalAlt: media.image?.altText || "",
            status: "failed",
          },
          update: { status: "failed" },
        });

        await db.optimizationJob.update({
          where: { id: jobId },
          data: { errorCount: progress.errorCount },
        });
      }

      // BUG-005 FIX: Small delay between images to reduce connection pressure
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return { ...progress, cancelled: false };
}

// ─── Revert Helpers ────────────────────────────────────────────────────────────

/**
 * Revert a single optimization record: delete WebP, restore original from backup.
 *
 * BUG-004 FIX: After reverting, DELETE the optimization record(s) from the DB
 * so the image is detected as "new" on next refresh and can be re-optimized.
 */
export async function revertSingleOptimization(
  admin: ShopifyAdmin,
  opt: {
    id: string;
    shop: string;
    productId: string;
    imageId: string;
    webpGid: string | null;
    backupUrl: string | null;
    originalUrl: string;
    originalAlt: string | null;
  },
): Promise<void> {
  const restoreSource = opt.backupUrl || opt.originalUrl;

  if (opt.webpGid) {
    try {
      await deleteProductMedia(admin, opt.productId, [opt.webpGid]);
    } catch (e) {
      console.error(`Warning: Could not delete WebP media ${opt.webpGid}:`, e);
      // Continue with restore even if delete fails
    }
  }

  await createProductMedia(admin, opt.productId, restoreSource, opt.originalAlt || "");

  // BUG-004 FIX: Delete the optimization record so the restored image
  // will be detected as "new" on next refresh
  await db.imageOptimization.delete({
    where: { id: opt.id },
  });

  // Also delete any tracking record for the WebP media ID
  if (opt.webpGid) {
    try {
      await db.imageOptimization.deleteMany({
        where: {
          shop: opt.shop,
          imageId: opt.webpGid,
        },
      });
    } catch (e) {
      // Non-critical
      console.log(`Note: No tracking record to delete for ${opt.webpGid}`);
    }
  }
}

// ─── Concurrent Job Guard ─────────────────────────────────────────────────────

/**
 * BUG-007 FIX: Check if there's already a running optimization job for this shop.
 * Returns the running job if one exists, null otherwise.
 */
export async function getRunningJob(shop: string) {
  return db.optimizationJob.findFirst({
    where: { shop, status: "running" },
    orderBy: { createdAt: "desc" },
  });
}

// ─── Image Counting ────────────────────────────────────────────────────────────

/**
 * Count images that need processing across all products.
 *
 * BUG-001/BUG-002 FIX: Only count images that do NOT have a "completed" record
 * in the database. This prevents double-counting after re-optimization.
 */
export async function countImagesToProcess(
  shop: string,
  products: ShopifyProduct[],
  targetImageId: string | null,
): Promise<{ totalImages: number; newImages: number; imagesToProcess: number }> {
  let totalImages = 0;
  let newImages = 0;
  let imagesToProcess = 0;

  for (const product of products) {
    const mediaImages = getProductImages(product);
    totalImages += mediaImages.length;

    for (const media of mediaImages) {
      if (targetImageId && media.id !== targetImageId) continue;

      const existing = await db.imageOptimization.findUnique({
        where: { shop_imageId: { shop, imageId: media.id } },
      });

      if (!existing) {
        // Truly new image — no record at all
        newImages++;
        imagesToProcess++;
      } else if (existing.status === "failed") {
        // Failed images can be retried
        newImages++;
        imagesToProcess++;
      }
      // "completed" and "processing" images are NOT counted as new
      // "reverted" records are deleted (BUG-004 fix), so they won't appear here
    }
  }

  return { totalImages, newImages, imagesToProcess };
}
