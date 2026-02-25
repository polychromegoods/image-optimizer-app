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

  // Step 2: Backup original to Shopify Files
  const extension = getExtensionFromUrl(media.image.url);
  const backupFilename = `backup-${extractIdFromGid(media.id)}.${extension}`;
  const backupMimeType = getMimeType(extension);

  const backupUrl = await uploadBackupToFiles(admin, imageBuffer, backupFilename, backupMimeType);

  // Step 3: Convert to WebP
  const webpBuffer = await sharp(imageBuffer)
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  const webpSize = webpBuffer.length;

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

      // Skip already-completed images (unless retrying)
      if (!isRetry && !targetImageId) {
        const existing = await db.imageOptimization.findUnique({
          where: { shop_imageId: { shop, imageId: media.id } },
        });
        if (existing && existing.status === "completed") {
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
    }
  }

  return { ...progress, cancelled: false };
}

// ─── Revert Helpers ────────────────────────────────────────────────────────────

/**
 * Revert a single optimization record: delete WebP, restore original from backup.
 */
export async function revertSingleOptimization(
  admin: ShopifyAdmin,
  opt: {
    id: string;
    productId: string;
    webpGid: string | null;
    backupUrl: string | null;
    originalUrl: string;
    originalAlt: string | null;
  },
): Promise<void> {
  const restoreSource = opt.backupUrl || opt.originalUrl;

  if (opt.webpGid) {
    await deleteProductMedia(admin, opt.productId, [opt.webpGid]);
  }

  await createProductMedia(admin, opt.productId, restoreSource, opt.originalAlt || "");

  await db.imageOptimization.update({
    where: { id: opt.id },
    data: { status: "reverted", altTextUpdated: false },
  });
}

// ─── Image Counting ────────────────────────────────────────────────────────────

/**
 * Count images that need processing across all products.
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

      if (!existing || existing.status === "failed") {
        newImages++;
      }

      if (!existing || existing.status !== "completed") {
        imagesToProcess++;
      }
    }
  }

  return { totalImages, newImages, imagesToProcess };
}
