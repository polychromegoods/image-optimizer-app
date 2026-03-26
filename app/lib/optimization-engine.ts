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
 *
 * BUG-009 FIX: Store the new WebP media ID in `newMediaId` field on the SAME record
 * instead of creating a duplicate record. This prevents double-counting and duplicate rows.
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
        newMediaId: media.id, // Same as original since we didn't replace
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

  let backupUrl: string;
  try {
    backupUrl = await uploadBackupToFiles(admin, imageBuffer, backupFilename, backupMimeType);
  } catch (backupError) {
    console.error(`Failed to backup original for ${media.id}, aborting optimization:`, backupError);
    throw new Error(`Backup failed for ${media.id}: ${backupError instanceof Error ? backupError.message : String(backupError)}`);
  }

  // Step 4: Upload WebP (BEFORE deleting original — safe optimization)
  let webpResourceUrl: string;
  try {
    webpResourceUrl = await uploadWebpImage(admin, webpBuffer, fileName);
  } catch (uploadError) {
    console.error(`Failed to upload WebP for ${media.id}, aborting (original preserved):`, uploadError);
    throw new Error(`WebP upload failed for ${media.id}: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
  }

  // Step 5: Create new product media with WebP FIRST (before deleting original)
  // This ensures the product always has images even if something fails
  let newMediaId: string | null;
  let newImageUrl: string | null;
  try {
    const result = await createProductMedia(admin, productId, webpResourceUrl, altText);
    newMediaId = result.mediaId;
    newImageUrl = result.imageUrl;
  } catch (createError) {
    console.error(`Failed to create WebP media on product for ${media.id}, aborting (original preserved):`, createError);
    throw new Error(`Media creation failed for ${media.id}: ${createError instanceof Error ? createError.message : String(createError)}`);
  }

  // Step 6: Delete original product media ONLY after WebP is successfully attached
  try {
    await deleteProductMedia(admin, productId, [media.id]);
  } catch (deleteError) {
    // Non-fatal: the product now has both original and WebP
    // We still record the optimization as completed
    console.warn(`Warning: Could not delete original media ${media.id} (product may have duplicate):`, deleteError);
  }

  // Step 7: Update database record
  const savings = originalSize - webpSize;
  progress.totalSaved += savings;
  progress.processedCount++;

  // BUG-009 FIX: Store newMediaId on the SAME record instead of creating a duplicate.
  // This single record tracks the full lifecycle: original → optimized.
  // The newMediaId field lets countImagesToProcess recognize the WebP image on refresh.
  await db.imageOptimization.update({
    where: { shop_imageId: { shop, imageId: media.id } },
    data: {
      webpUrl: newImageUrl || webpResourceUrl,
      webpGid: newMediaId,
      newMediaId: newMediaId || null,
      backupUrl,
      fileSize: originalSize,
      webpFileSize: webpSize,
      status: "completed",
      altTextUpdated: seoSettings?.autoApplyOnOptimize ?? false,
    },
  });

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
 * matching by EITHER the original media ID or the newMediaId field.
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

      // BUG-001 + BUG-009 FIX: Skip already-completed images (unless retrying)
      // Check by media ID directly, AND check if any record has this as newMediaId
      if (!isRetry && !targetImageId) {
        const existingByImageId = await db.imageOptimization.findUnique({
          where: { shop_imageId: { shop, imageId: media.id } },
        });

        if (existingByImageId && existingByImageId.status === "completed") {
          progress.skippedCount++;
          await db.optimizationJob.update({
            where: { id: jobId },
            data: { skippedCount: progress.skippedCount },
          });
          continue;
        }

        // Also check if this media ID is the newMediaId of an existing optimization
        // (this is the WebP image that replaced an original)
        const existingByNewMediaId = await db.imageOptimization.findFirst({
          where: { shop, newMediaId: media.id, status: "completed" },
        });

        if (existingByNewMediaId) {
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
 * BUG-004 FIX: After reverting, DELETE the optimization record from the DB
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
    newMediaId: string | null;
    backupUrl: string | null;
    originalUrl: string;
    originalAlt: string | null;
  },
): Promise<void> {
  const restoreSource = opt.backupUrl || opt.originalUrl;

  if (!restoreSource) {
    console.error(`Cannot revert ${opt.imageId}: no backup URL or original URL available`);
    // Still clean up the DB record so it doesn't block future operations
    await db.imageOptimization.delete({ where: { id: opt.id } });
    return;
  }

  // SAFE REVERT: Restore original FIRST, then delete WebP
  // This ensures the product always has at least one image
  console.log(`[Revert] Restoring original for ${opt.imageId} from: ${restoreSource}`);
  try {
    await createProductMedia(admin, opt.productId, restoreSource, opt.originalAlt || "");
  } catch (restoreError) {
    console.error(`Failed to restore original for ${opt.imageId}:`, restoreError);
    throw new Error(`Revert failed: could not restore original image. WebP version preserved. Error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
  }

  // Now delete the WebP media (safe because original is already restored)
  const mediaToDelete = opt.newMediaId || opt.webpGid;
  if (mediaToDelete) {
    try {
      await deleteProductMedia(admin, opt.productId, [mediaToDelete]);
    } catch (e) {
      // Non-fatal: product now has both original and WebP
      console.warn(`Warning: Could not delete WebP media ${mediaToDelete} (product may have duplicate):`, e);
    }
  }

  // BUG-004 FIX: Delete the optimization record so the restored image
  // will be detected as "new" on next refresh
  await db.imageOptimization.delete({
    where: { id: opt.id },
  });
  console.log(`[Revert] Successfully reverted ${opt.imageId}`);
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
 * BUG-001/BUG-002/BUG-009 FIX: Only count images that do NOT have a "completed"
 * record in the database. Check both `imageId` (direct match) and `newMediaId`
 * (the WebP replacement) to avoid double-counting.
 *
 * The "Optimized" counter should reflect the number of UNIQUE optimizations,
 * not the number of DB records.
 */
export async function countImagesToProcess(
  shop: string,
  products: ShopifyProduct[],
  targetImageId: string | null,
): Promise<{ totalImages: number; newImages: number; imagesToProcess: number; optimizedCount: number }> {
  let totalImages = 0;
  let newImages = 0;
  let imagesToProcess = 0;
  let optimizedCount = 0;

  console.log(`[countImagesToProcess] shop=${shop}, products=${products.length}, targetImageId=${targetImageId}`);

  // OPT-05 FIX: Clean up stale "processing" records that were left behind
  // by cancelled or crashed optimizations. These should not inflate the counter.
  // Only clean up records that are NOT part of a currently running job.
  const runningJob = await db.optimizationJob.findFirst({
    where: { shop, status: "running" },
  });

  if (!runningJob) {
    // No job running — any "processing" records are stale, reset them to allow re-processing
    await db.imageOptimization.deleteMany({
      where: { shop, status: "processing" },
    });
  }

  // Pre-fetch all optimization records for this shop to avoid N+1 queries
  const allRecords = await db.imageOptimization.findMany({
    where: { shop },
    select: { imageId: true, newMediaId: true, status: true },
  });

  // Build lookup sets for fast checking
  // OPT-05 FIX: Only count "completed" status as optimized, NOT "processing"
  const completedByImageId = new Set<string>();
  const completedByNewMediaId = new Set<string>();
  const failedByImageId = new Set<string>();

  for (const rec of allRecords) {
    if (rec.status === "completed") {
      completedByImageId.add(rec.imageId);
      if (rec.newMediaId) {
        completedByNewMediaId.add(rec.newMediaId);
      }
    } else if (rec.status === "failed") {
      failedByImageId.add(rec.imageId);
    }
  }

  for (const product of products) {
    const mediaImages = getProductImages(product);
    console.log(`[countImagesToProcess] Product "${product.title}" (${product.id}): ${mediaImages.length} images, raw media edges: ${product.media?.edges?.length || 0}`);
    totalImages += mediaImages.length;

    for (const media of mediaImages) {
      if (targetImageId && media.id !== targetImageId) continue;

      // Check if this image is already optimized:
      // 1. Direct match: this media ID has a completed record
      // 2. NewMediaId match: this media ID is the WebP replacement of a completed optimization
      const isCompletedDirectly = completedByImageId.has(media.id);
      const isCompletedAsWebp = completedByNewMediaId.has(media.id);

      if (isCompletedDirectly || isCompletedAsWebp) {
        optimizedCount++;
        continue;
      }

      if (failedByImageId.has(media.id)) {
        // Failed images can be retried
        newImages++;
        imagesToProcess++;
      } else {
        // Truly new image — no record at all
        newImages++;
        imagesToProcess++;
      }
    }
  }

  console.log(`[countImagesToProcess] RESULT: totalImages=${totalImages}, newImages=${newImages}, imagesToProcess=${imagesToProcess}, optimizedCount=${optimizedCount}`);
  return { totalImages, newImages, imagesToProcess, optimizedCount };
}
