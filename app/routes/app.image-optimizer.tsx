import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  Text,
  Banner,
  ProgressBar,
  Badge,
  InlineStack,
  Modal,
  Thumbnail,
  Box,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import sharp from "sharp";

function applyTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`#${key}#`, "g"), value);
  }
  result = result.replace(/\s+/g, " ").trim();
  result = result.replace(/[-_|,]\s*$/, "").trim();
  return result;
}

function makeFileName(
  template: string,
  variables: Record<string, string>,
): string {
  let result = applyTemplate(template, variables);
  return result
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Helper: Upload a buffer to Shopify Files via staged upload and return the permanent file URL
async function uploadToShopifyFiles(
  admin: any,
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  // Step 1: Create staged upload for FILE resource (permanent Shopify Files storage)
  const stagedUploadResponse = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: [
          {
            resource: "FILE",
            filename,
            mimeType,
            httpMethod: "POST",
          },
        ],
      },
    },
  );

  const stagedData = await stagedUploadResponse.json();
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!target) {
    throw new Error("Failed to create staged upload for backup");
  }

  // Step 2: Upload the file
  const uploadFormData = new FormData();
  for (const param of target.parameters) {
    uploadFormData.append(param.name, param.value);
  }
  uploadFormData.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    filename,
  );

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: uploadFormData,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Backup upload failed: ${uploadResponse.statusText}`);
  }

  // Step 3: Create the file in Shopify Files so it persists permanently
  const fileCreateResponse = await admin.graphql(
    `#graphql
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            ... on GenericFile {
              id
              url
            }
            ... on MediaImage {
              id
              image {
                url
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        files: [
          {
            alt: "Backup original image",
            contentType: "IMAGE",
            originalSource: target.resourceUrl,
          },
        ],
      },
    },
  );

  const fileData = await fileCreateResponse.json();
  const createdFile = fileData.data?.fileCreate?.files?.[0];

  if (fileData.data?.fileCreate?.userErrors?.length > 0) {
    console.error("File create errors:", fileData.data.fileCreate.userErrors);
  }

  // The resourceUrl from staged upload is the permanent URL we can use
  // The file might take a moment to process, but resourceUrl is immediately usable
  return target.resourceUrl;
}

// Helper: Upload WebP to Shopify via staged upload for product media
async function uploadWebpForProduct(
  admin: any,
  webpBuffer: Buffer,
  fileName: string,
): Promise<{ url: string; resourceUrl: string }> {
  const stagedUploadResponse = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: [
          {
            resource: "IMAGE",
            filename: `${fileName}.webp`,
            mimeType: "image/webp",
            httpMethod: "POST",
          },
        ],
      },
    },
  );

  const stagedData = await stagedUploadResponse.json();
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!target) {
    throw new Error("Failed to create staged upload for WebP");
  }

  const uploadFormData = new FormData();
  for (const param of target.parameters) {
    uploadFormData.append(param.name, param.value);
  }
  uploadFormData.append(
    "file",
    new Blob([webpBuffer], { type: "image/webp" }),
    `${fileName}.webp`,
  );

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: uploadFormData,
  });

  if (!uploadResponse.ok) {
    throw new Error(`WebP upload failed: ${uploadResponse.statusText}`);
  }

  return { url: target.url, resourceUrl: target.resourceUrl };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const stats = await db.imageOptimization.groupBy({
    by: ["status"],
    where: { shop },
    _count: {
      status: true,
    },
  });

  const recentOptimizations = await db.imageOptimization.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const response = await admin.graphql(
    `#graphql
      query getProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
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
                      image {
                        url
                        altText
                        width
                        height
                      }
                      mediaContentType
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { first: 250 } },
  );

  const data = await response.json();
  const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

  let totalImages = 0;
  let newImages = 0;

  for (const product of products) {
    const mediaImages =
      product.media?.edges
        ?.map((e: any) => e.node)
        ?.filter((m: any) => m.mediaContentType === "IMAGE") || [];

    totalImages += mediaImages.length;

    for (const media of mediaImages) {
      const existing = await db.imageOptimization.findUnique({
        where: {
          shop_imageId: {
            shop,
            imageId: media.id,
          },
        },
      });

      if (!existing || existing.status === "failed") {
        newImages++;
      }
    }
  }

  const seoSettings = await db.seoSettings.findUnique({
    where: { shop },
  });

  // Count how many reverted records have a backupUrl (for recovery button)
  const revertedWithBackup = await db.imageOptimization.count({
    where: { shop, status: "reverted", backupUrl: { not: null } },
  });

  return json({
    shop,
    stats,
    recentOptimizations,
    products,
    totalImages,
    newImages,
    seoSettings,
    revertedWithBackup,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "refresh") {
    return json({ success: true, message: "Refreshed" });
  }

  // ===== OPTIMIZE NEW or RETRY SINGLE =====
  if (actionType === "optimize_new" || actionType === "retry_single") {
    const seoSettings = await db.seoSettings.findUnique({
      where: { shop },
    });

    const shopResponse = await admin.graphql(
      `#graphql
        query {
          shop {
            name
          }
        }
      `,
    );
    const shopData = await shopResponse.json();
    const shopName = shopData.data?.shop?.name || shop;

    let targetImageId: string | null = null;
    if (actionType === "retry_single") {
      targetImageId = formData.get("imageId") as string;
    }

    const response = await admin.graphql(
      `#graphql
        query getProducts($first: Int!) {
          products(first: $first) {
            edges {
              node {
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
                        image {
                          url
                          altText
                          width
                          height
                        }
                        mediaContentType
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { first: 250 } },
    );

    const data = await response.json();
    const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let totalSaved = 0;

    for (const product of products) {
      const productId = product.id;
      const mediaImages =
        product.media?.edges
          ?.map((e: any) => e.node)
          ?.filter((m: any) => m.mediaContentType === "IMAGE") || [];

      for (let i = 0; i < mediaImages.length; i++) {
        const media = mediaImages[i];

        if (targetImageId && media.id !== targetImageId) {
          continue;
        }

        try {
          const existing = await db.imageOptimization.findUnique({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
          });

          if (
            actionType === "optimize_new" &&
            existing &&
            existing.status === "completed"
          ) {
            skippedCount++;
            continue;
          }

          await db.imageOptimization.upsert({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
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

          const templateVars = {
            product_name: product.title || "",
            vendor: product.vendor || "",
            product_type: product.productType || "",
            shop_name: shopName,
            product_handle: product.handle || "",
            variant_title: "",
            image_number: String(i + 1),
          };

          let altText = media.image.altText || product.title || "";
          let fileName = `optimized-${media.id.split("/").pop()}`;

          if (seoSettings && seoSettings.autoApplyOnOptimize) {
            if (seoSettings.altTextTemplate) {
              altText = applyTemplate(
                seoSettings.altTextTemplate,
                templateVars,
              );
            }
            if (seoSettings.fileNameTemplate) {
              fileName = makeFileName(
                seoSettings.fileNameTemplate,
                templateVars,
              );
            }
          }

          // Step 1: Fetch the original image
          const imageResponse = await fetch(media.image.url);
          const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
          const originalSize = imageBuffer.length;

          // Step 2: BACKUP - Upload original to Shopify Files for permanent storage
          const originalExtension = media.image.url
            .split("?")[0]
            .split(".")
            .pop() || "png";
          const backupFilename = `backup-${media.id.split("/").pop()}.${originalExtension}`;
          const backupMimeType =
            originalExtension === "jpg" || originalExtension === "jpeg"
              ? "image/jpeg"
              : originalExtension === "webp"
                ? "image/webp"
                : "image/png";

          let backupUrl: string;
          try {
            backupUrl = await uploadToShopifyFiles(
              admin,
              imageBuffer,
              backupFilename,
              backupMimeType,
            );
          } catch (backupError) {
            console.error("Backup upload failed, skipping image:", backupError);
            throw new Error(
              `Backup failed for image ${media.id}: ${backupError}`,
            );
          }

          // Step 3: Convert to WebP
          const webpBuffer = await sharp(imageBuffer)
            .webp({ quality: 85 })
            .toBuffer();
          const webpSize = webpBuffer.length;

          // Step 4: Upload WebP for product media
          const { resourceUrl: webpResourceUrl } = await uploadWebpForProduct(
            admin,
            webpBuffer,
            fileName,
          );

          // Step 5: Delete original product media
          const deleteResponse = await admin.graphql(
            `#graphql
              mutation productDeleteMedia($mediaIds: [ID!]!, $productId: ID!) {
                productDeleteMedia(mediaIds: $mediaIds, productId: $productId) {
                  deletedMediaIds
                  mediaUserErrors {
                    field
                    message
                  }
                }
              }
            `,
            {
              variables: {
                productId,
                mediaIds: [media.id],
              },
            },
          );

          const deleteData = await deleteResponse.json();
          if (
            deleteData.data?.productDeleteMedia?.mediaUserErrors?.length > 0
          ) {
            console.error(
              "Delete errors:",
              deleteData.data.productDeleteMedia.mediaUserErrors,
            );
          }

          // Step 6: Create new product media with WebP
          const createMediaResponse = await admin.graphql(
            `#graphql
              mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
                productCreateMedia(media: $media, productId: $productId) {
                  media {
                    ... on MediaImage {
                      id
                      image {
                        url
                      }
                    }
                  }
                  mediaUserErrors {
                    field
                    message
                  }
                }
              }
            `,
            {
              variables: {
                productId,
                media: [
                  {
                    alt: altText,
                    mediaContentType: "IMAGE",
                    originalSource: webpResourceUrl,
                  },
                ],
              },
            },
          );

          const createData = await createMediaResponse.json();
          const newMedia = createData.data?.productCreateMedia?.media?.[0];

          if (
            createData.data?.productCreateMedia?.mediaUserErrors?.length > 0
          ) {
            throw new Error(
              createData.data.productCreateMedia.mediaUserErrors
                .map((e: any) => e.message)
                .join(", "),
            );
          }

          const savings = originalSize - webpSize;
          totalSaved += savings;

          // Step 7: Save record with backupUrl for safe revert
          await db.imageOptimization.update({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
            data: {
              webpUrl: newMedia?.image?.url || webpResourceUrl,
              webpGid: newMedia?.id || null,
              backupUrl: backupUrl,
              fileSize: originalSize,
              webpFileSize: webpSize,
              status: "completed",
              altTextUpdated: seoSettings?.autoApplyOnOptimize ? true : false,
            },
          });

          processedCount++;
        } catch (error) {
          console.error(`Error processing image ${media.id}:`, error);
          errorCount++;

          await db.imageOptimization.upsert({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
            create: {
              shop,
              productId,
              imageId: media.id,
              originalUrl: media.image?.url || "",
              originalGid: media.id,
              originalAlt: media.image?.altText || "",
              status: "failed",
            },
            update: {
              status: "failed",
            },
          });
        }
      }
    }

    return json({
      success: true,
      actionType: actionType === "retry_single" ? "retry" : "optimize",
      processedCount,
      errorCount,
      skippedCount,
      totalSaved,
    });
  }

  // ===== REVERT ALL =====
  if (actionType === "revert_all") {
    const optimizations = await db.imageOptimization.findMany({
      where: { shop, status: "completed" },
    });

    let revertedCount = 0;
    let errorCount = 0;

    for (const opt of optimizations) {
      try {
        // Use backupUrl (permanent Shopify Files URL) instead of originalUrl
        const restoreSource = opt.backupUrl || opt.originalUrl;

        // First verify the restore source is accessible
        try {
          const checkResponse = await fetch(restoreSource, { method: "HEAD" });
          if (!checkResponse.ok) {
            console.error(
              `Restore source not accessible for ${opt.imageId}: ${checkResponse.status}`,
            );
            // Try the other URL as fallback
            const fallbackUrl =
              opt.backupUrl === restoreSource
                ? opt.originalUrl
                : opt.backupUrl;
            if (fallbackUrl) {
              const fallbackCheck = await fetch(fallbackUrl, {
                method: "HEAD",
              });
              if (!fallbackCheck.ok) {
                throw new Error("Neither backup nor original URL is accessible");
              }
            }
          }
        } catch (checkError) {
          console.warn(
            `URL check failed for ${opt.imageId}, attempting restore anyway:`,
            checkError,
          );
        }

        // Delete the WebP version from the product
        if (opt.webpGid) {
          const deleteResp = await admin.graphql(
            `#graphql
              mutation productDeleteMedia($mediaIds: [ID!]!, $productId: ID!) {
                productDeleteMedia(mediaIds: $mediaIds, productId: $productId) {
                  deletedMediaIds
                  mediaUserErrors {
                    field
                    message
                  }
                }
              }
            `,
            {
              variables: {
                productId: opt.productId,
                mediaIds: [opt.webpGid],
              },
            },
          );
          const deleteData = await deleteResp.json();
          if (
            deleteData.data?.productDeleteMedia?.mediaUserErrors?.length > 0
          ) {
            console.error(
              "Delete errors during revert:",
              deleteData.data.productDeleteMedia.mediaUserErrors,
            );
          }
        }

        // Re-create product media from the backup/original
        const createResp = await admin.graphql(
          `#graphql
            mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
              productCreateMedia(media: $media, productId: $productId) {
                media {
                  ... on MediaImage {
                    id
                    image {
                      url
                    }
                  }
                }
                mediaUserErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            variables: {
              productId: opt.productId,
              media: [
                {
                  alt: opt.originalAlt || "",
                  mediaContentType: "IMAGE",
                  originalSource: restoreSource,
                },
              ],
            },
          },
        );

        const createData = await createResp.json();
        if (
          createData.data?.productCreateMedia?.mediaUserErrors?.length > 0
        ) {
          const errors = createData.data.productCreateMedia.mediaUserErrors
            .map((e: any) => e.message)
            .join(", ");
          throw new Error(`Failed to create media: ${errors}`);
        }

        await db.imageOptimization.update({
          where: { id: opt.id },
          data: { status: "reverted", altTextUpdated: false },
        });

        revertedCount++;
      } catch (error) {
        console.error(`Error reverting image ${opt.imageId}:`, error);
        errorCount++;
      }
    }

    return json({
      success: true,
      actionType: "revert",
      revertedCount,
      errorCount,
    });
  }

  // ===== REVERT SINGLE =====
  if (actionType === "revert_single") {
    const optimizationId = formData.get("optimizationId") as string;

    try {
      const opt = await db.imageOptimization.findUnique({
        where: { id: optimizationId },
      });

      if (!opt || opt.status !== "completed") {
        return json({
          success: false,
          message: "Optimization not found or not completed",
        });
      }

      const restoreSource = opt.backupUrl || opt.originalUrl;

      if (opt.webpGid) {
        await admin.graphql(
          `#graphql
            mutation productDeleteMedia($mediaIds: [ID!]!, $productId: ID!) {
              productDeleteMedia(mediaIds: $mediaIds, productId: $productId) {
                deletedMediaIds
                mediaUserErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            variables: {
              productId: opt.productId,
              mediaIds: [opt.webpGid],
            },
          },
        );
      }

      const createResp = await admin.graphql(
        `#graphql
          mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
            productCreateMedia(media: $media, productId: $productId) {
              media {
                ... on MediaImage {
                  id
                  image {
                    url
                  }
                }
              }
              mediaUserErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            productId: opt.productId,
            media: [
              {
                alt: opt.originalAlt || "",
                mediaContentType: "IMAGE",
                originalSource: restoreSource,
              },
            ],
          },
        },
      );

      const createData = await createResp.json();
      if (createData.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
        const errors = createData.data.productCreateMedia.mediaUserErrors
          .map((e: any) => e.message)
          .join(", ");
        throw new Error(`Failed to create media: ${errors}`);
      }

      await db.imageOptimization.update({
        where: { id: opt.id },
        data: { status: "reverted", altTextUpdated: false },
      });

      return json({ success: true, actionType: "revert_single" });
    } catch (error) {
      console.error("Error reverting single image:", error);
      return json({ success: false, message: "Failed to revert image" });
    }
  }

  // ===== RESTORE MISSING IMAGES =====
  // This action finds all "reverted" records and tries to re-add images to products
  // that are missing them, using backupUrl or originalUrl
  if (actionType === "restore_missing") {
    const revertedRecords = await db.imageOptimization.findMany({
      where: { shop, status: "reverted" },
    });

    let restoredCount = 0;
    let errorCount = 0;

    for (const opt of revertedRecords) {
      try {
        // Try backupUrl first, then originalUrl
        const restoreSource = opt.backupUrl || opt.originalUrl;

        const createResp = await admin.graphql(
          `#graphql
            mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
              productCreateMedia(media: $media, productId: $productId) {
                media {
                  ... on MediaImage {
                    id
                    image {
                      url
                    }
                  }
                }
                mediaUserErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            variables: {
              productId: opt.productId,
              media: [
                {
                  alt: opt.originalAlt || "",
                  mediaContentType: "IMAGE",
                  originalSource: restoreSource,
                },
              ],
            },
          },
        );

        const createData = await createResp.json();
        if (
          createData.data?.productCreateMedia?.mediaUserErrors?.length > 0
        ) {
          const errors = createData.data.productCreateMedia.mediaUserErrors
            .map((e: any) => e.message)
            .join(", ");
          throw new Error(`Failed to restore: ${errors}`);
        }

        // Reset to pending so it can be re-optimized
        await db.imageOptimization.update({
          where: { id: opt.id },
          data: { status: "restored" },
        });

        restoredCount++;
      } catch (error) {
        console.error(`Error restoring image ${opt.imageId}:`, error);
        errorCount++;
      }
    }

    return json({
      success: true,
      actionType: "restore",
      restoredCount,
      errorCount,
    });
  }

  return json({ success: false });
};

export default function ImageOptimizer() {
  const {
    shop,
    stats,
    recentOptimizations,
    products,
    totalImages,
    newImages,
    seoSettings,
    revertedWithBackup,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [showRevertModal, setShowRevertModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [compareImage, setCompareImage] = useState<any>(null);

  const isOptimizing =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "optimize_new";
  const isRefreshing =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "refresh";
  const isReverting =
    navigation.state === "submitting" &&
    (navigation.formData?.get("action") === "revert_all" ||
      navigation.formData?.get("action") === "revert_single");
  const isRetrying =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "retry_single";
  const isRestoring =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "restore_missing";

  const statsMap = stats.reduce(
    (acc: any, stat: any) => {
      acc[stat.status] = stat._count.status;
      return acc;
    },
    { pending: 0, processing: 0, completed: 0, failed: 0, reverted: 0, restored: 0 },
  );

  const completionPercentage =
    totalImages > 0 ? (statsMap.completed / totalImages) * 100 : 0;

  const handleOptimizeNew = () => {
    const formData = new FormData();
    formData.append("action", "optimize_new");
    submit(formData, { method: "post" });
  };

  const handleRefresh = () => {
    const formData = new FormData();
    formData.append("action", "refresh");
    submit(formData, { method: "post", replace: true });
  };

  const handleRevertAll = useCallback(() => {
    const formData = new FormData();
    formData.append("action", "revert_all");
    submit(formData, { method: "post" });
    setShowRevertModal(false);
  }, [submit]);

  const handleRevertSingle = (optimizationId: string) => {
    const formData = new FormData();
    formData.append("action", "revert_single");
    formData.append("optimizationId", optimizationId);
    submit(formData, { method: "post" });
  };

  const handleRetrySingle = (imageId: string) => {
    const formData = new FormData();
    formData.append("action", "retry_single");
    formData.append("imageId", imageId);
    submit(formData, { method: "post" });
  };

  const handleRestoreMissing = useCallback(() => {
    const formData = new FormData();
    formData.append("action", "restore_missing");
    submit(formData, { method: "post" });
    setShowRestoreModal(false);
  }, [submit]);

  const handleCompare = (opt: any) => {
    setCompareImage(opt);
  };

  // Build a product lookup map for performance
  const productMap: Record<string, string> = {};
  for (const p of products) {
    productMap[p.id] = p.title;
  }

  return (
    <Page
      title="Image Optimizer"
      subtitle="Compress product images to WebP for faster loading. Original images are backed up and can be restored anytime."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Result banners */}
            {actionData?.actionType === "optimize" && (
              <Banner
                tone={actionData.errorCount > 0 ? "warning" : "success"}
                title="Optimization Complete"
              >
                <p>
                  Processed: {actionData.processedCount} | Skipped:{" "}
                  {actionData.skippedCount} | Errors: {actionData.errorCount}
                  {actionData.totalSaved > 0 &&
                    ` | Total saved: ${(actionData.totalSaved / 1024).toFixed(1)} KB`}
                </p>
              </Banner>
            )}

            {actionData?.actionType === "retry" && (
              <Banner
                tone={actionData.errorCount > 0 ? "warning" : "success"}
                title="Retry Complete"
              >
                <p>
                  Processed: {actionData.processedCount} | Errors:{" "}
                  {actionData.errorCount}
                </p>
              </Banner>
            )}

            {actionData?.actionType === "revert" && (
              <Banner
                tone={
                  actionData.errorCount > 0
                    ? actionData.revertedCount > 0
                      ? "warning"
                      : "critical"
                    : "success"
                }
                title="Revert Complete"
              >
                <p>
                  Reverted {actionData.revertedCount} image
                  {actionData.revertedCount !== 1 ? "s" : ""} back to originals.
                  {actionData.errorCount > 0 &&
                    ` ${actionData.errorCount} error(s) occurred.`}
                </p>
              </Banner>
            )}

            {actionData?.actionType === "restore" && (
              <Banner
                tone={actionData.errorCount > 0 ? "warning" : "success"}
                title="Restore Complete"
              >
                <p>
                  Restored {actionData.restoredCount} image
                  {actionData.restoredCount !== 1 ? "s" : ""}.
                  {actionData.errorCount > 0 &&
                    ` ${actionData.errorCount} error(s) occurred.`}
                </p>
              </Banner>
            )}

            {seoSettings?.autoApplyOnOptimize && (
              <Banner tone="info">
                <p>
                  SEO alt text and filenames will be applied automatically during
                  optimization.
                  <a href="/app/settings"> Edit templates</a>
                </p>
              </Banner>
            )}

            {/* Refresh card */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Sync Images
                </Text>
                <Text as="p" tone="subdued">
                  If you uploaded new product images, click refresh to detect
                  them.
                </Text>
                <div>
                  <Button onClick={handleRefresh} loading={isRefreshing}>
                    Refresh
                  </Button>
                </div>
              </BlockStack>
            </Card>

            {newImages > 0 && (
              <Banner tone="info">
                <p>
                  Found {newImages} new image{newImages !== 1 ? "s" : ""} ready
                  to optimize.
                </p>
              </Banner>
            )}

            {/* Optimize card */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Optimization Progress
                </Text>
                <ProgressBar progress={completionPercentage} size="small" />
                <BlockStack gap="200">
                  <Text as="p">Total images: {totalImages}</Text>
                  <Text as="p">
                    Optimized: {statsMap.completed} | Failed: {statsMap.failed} |
                    Reverted: {statsMap.reverted || 0}
                  </Text>
                </BlockStack>
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={handleOptimizeNew}
                    size="large"
                    loading={isOptimizing}
                    disabled={newImages === 0}
                  >
                    {newImages > 0
                      ? `Optimize ${newImages} New Image${newImages !== 1 ? "s" : ""}`
                      : "No New Images to Optimize"}
                  </Button>
                  {statsMap.completed > 0 && (
                    <Button
                      tone="critical"
                      onClick={() => setShowRevertModal(true)}
                      loading={isReverting}
                    >
                      Revert All to Originals
                    </Button>
                  )}
                  {(statsMap.reverted || 0) > 0 && (
                    <Button
                      onClick={() => setShowRestoreModal(true)}
                      loading={isRestoring}
                    >
                      Restore Missing Images
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Recent optimizations with thumbnails */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Recent Optimizations
                </Text>
                {recentOptimizations.length > 0 ? (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: "14px",
                      }}
                    >
                      <thead>
                        <tr
                          style={{
                            borderBottom: "1px solid #e1e3e5",
                            textAlign: "left",
                          }}
                        >
                          <th style={{ padding: "12px 8px" }}>Preview</th>
                          <th style={{ padding: "12px 8px" }}>Product</th>
                          <th style={{ padding: "12px 8px" }}>Status</th>
                          <th style={{ padding: "12px 8px" }}>Original</th>
                          <th style={{ padding: "12px 8px" }}>WebP</th>
                          <th style={{ padding: "12px 8px" }}>Savings</th>
                          <th style={{ padding: "12px 8px" }}>Backup</th>
                          <th style={{ padding: "12px 8px" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentOptimizations.map((opt: any) => {
                          const thumbUrl = opt.webpUrl || opt.originalUrl;
                          const productName =
                            productMap[opt.productId] ||
                            opt.productId.split("/").pop();

                          return (
                            <tr
                              key={opt.id}
                              style={{
                                borderBottom: "1px solid #f1f2f3",
                              }}
                            >
                              {/* Thumbnail */}
                              <td style={{ padding: "8px" }}>
                                {thumbUrl ? (
                                  <div
                                    onClick={() =>
                                      opt.status === "completed" &&
                                      handleCompare(opt)
                                    }
                                    style={{
                                      cursor:
                                        opt.status === "completed"
                                          ? "pointer"
                                          : "default",
                                    }}
                                    title={
                                      opt.status === "completed"
                                        ? "Click to compare original vs WebP"
                                        : ""
                                    }
                                  >
                                    <Thumbnail
                                      source={thumbUrl}
                                      alt={`Image ${opt.imageId.split("/").pop()}`}
                                      size="small"
                                    />
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      width: 40,
                                      height: 40,
                                      backgroundColor: "#f1f2f3",
                                      borderRadius: 4,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      fontSize: "10px",
                                      color: "#8c9196",
                                    }}
                                  >
                                    N/A
                                  </div>
                                )}
                              </td>

                              {/* Product name */}
                              <td style={{ padding: "8px" }}>
                                <Text
                                  as="span"
                                  variant="bodyMd"
                                  fontWeight="semibold"
                                >
                                  {productName}
                                </Text>
                              </td>

                              {/* Status badge */}
                              <td style={{ padding: "8px" }}>
                                <Badge
                                  tone={
                                    opt.status === "completed"
                                      ? "success"
                                      : opt.status === "failed"
                                        ? "critical"
                                        : opt.status === "reverted"
                                          ? "warning"
                                          : opt.status === "restored"
                                            ? "info"
                                            : "info"
                                  }
                                >
                                  {opt.status}
                                </Badge>
                              </td>

                              {/* Original size */}
                              <td style={{ padding: "8px" }}>
                                {opt.fileSize
                                  ? `${(opt.fileSize / 1024).toFixed(1)} KB`
                                  : "-"}
                              </td>

                              {/* WebP size */}
                              <td style={{ padding: "8px" }}>
                                {opt.webpFileSize
                                  ? `${(opt.webpFileSize / 1024).toFixed(1)} KB`
                                  : "-"}
                              </td>

                              {/* Savings */}
                              <td style={{ padding: "8px" }}>
                                {opt.webpFileSize && opt.fileSize ? (
                                  <span
                                    style={{
                                      color: "#008060",
                                      fontWeight: 600,
                                    }}
                                  >
                                    {(
                                      ((opt.fileSize - opt.webpFileSize) /
                                        opt.fileSize) *
                                      100
                                    ).toFixed(1)}
                                    %
                                  </span>
                                ) : (
                                  "-"
                                )}
                              </td>

                              {/* Backup status */}
                              <td style={{ padding: "8px" }}>
                                {opt.backupUrl ? (
                                  <Badge tone="success">Backed up</Badge>
                                ) : (
                                  <Badge tone="warning">No backup</Badge>
                                )}
                              </td>

                              {/* Actions */}
                              <td style={{ padding: "8px" }}>
                                <InlineStack gap="200">
                                  {opt.status === "completed" && (
                                    <>
                                      <Button
                                        size="slim"
                                        onClick={() => handleCompare(opt)}
                                      >
                                        Compare
                                      </Button>
                                      <Button
                                        size="slim"
                                        tone="critical"
                                        onClick={() =>
                                          handleRevertSingle(opt.id)
                                        }
                                        loading={isReverting}
                                      >
                                        Revert
                                      </Button>
                                    </>
                                  )}
                                  {opt.status === "failed" && (
                                    <Button
                                      size="slim"
                                      variant="primary"
                                      onClick={() =>
                                        handleRetrySingle(opt.imageId)
                                      }
                                      loading={isRetrying}
                                    >
                                      Retry
                                    </Button>
                                  )}
                                </InlineStack>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Text as="p" tone="subdued">
                    No optimizations yet. Click Refresh, then Optimize to start.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Revert confirmation modal */}
      {showRevertModal && (
        <Modal
          open={showRevertModal}
          onClose={() => setShowRevertModal(false)}
          title="Revert All Images?"
          primaryAction={{
            content: "Revert All",
            destructive: true,
            onAction: handleRevertAll,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setShowRevertModal(false),
            },
          ]}
        >
          <Modal.Section>
            <Text as="p">
              This will restore all {statsMap.completed} optimized images back to
              their originals using the backed-up copies. Your WebP versions will
              be removed from the products.
            </Text>
          </Modal.Section>
        </Modal>
      )}

      {/* Restore missing images modal */}
      {showRestoreModal && (
        <Modal
          open={showRestoreModal}
          onClose={() => setShowRestoreModal(false)}
          title="Restore Missing Images?"
          primaryAction={{
            content: "Restore Images",
            onAction: handleRestoreMissing,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setShowRestoreModal(false),
            },
          ]}
        >
          <Modal.Section>
            <Text as="p">
              This will attempt to restore {statsMap.reverted || 0} reverted
              images back to their products using backup copies. Images that were
              lost during a failed revert will be re-added.
            </Text>
          </Modal.Section>
        </Modal>
      )}

      {/* Compare modal - Original vs WebP side by side */}
      {compareImage && (
        <Modal
          open={!!compareImage}
          onClose={() => setCompareImage(null)}
          title="Compare: Original vs WebP"
          large
          secondaryActions={[
            {
              content: "Close",
              onAction: () => setCompareImage(null),
            },
          ]}
        >
          <Modal.Section>
            <div
              style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}
            >
              {/* Original */}
              <div style={{ flex: 1, minWidth: "250px" }}>
                <BlockStack gap="300">
                  <InlineStack align="center" gap="200">
                    <Badge tone="warning">Original</Badge>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {compareImage.fileSize
                        ? `${(compareImage.fileSize / 1024).toFixed(1)} KB`
                        : ""}
                    </Text>
                  </InlineStack>
                  <div
                    style={{
                      border: "1px solid #e1e3e5",
                      borderRadius: "8px",
                      overflow: "hidden",
                      backgroundColor: "#fafafa",
                    }}
                  >
                    <img
                      src={compareImage.backupUrl || compareImage.originalUrl}
                      alt="Original"
                      style={{
                        width: "100%",
                        height: "auto",
                        display: "block",
                      }}
                    />
                  </div>
                </BlockStack>
              </div>

              {/* WebP */}
              <div style={{ flex: 1, minWidth: "250px" }}>
                <BlockStack gap="300">
                  <InlineStack align="center" gap="200">
                    <Badge tone="success">WebP (Optimized)</Badge>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {compareImage.webpFileSize
                        ? `${(compareImage.webpFileSize / 1024).toFixed(1)} KB`
                        : ""}
                    </Text>
                    {compareImage.fileSize && compareImage.webpFileSize && (
                      <Text as="span" variant="bodySm" tone="success">
                        {(
                          ((compareImage.fileSize -
                            compareImage.webpFileSize) /
                            compareImage.fileSize) *
                          100
                        ).toFixed(1)}
                        % smaller
                      </Text>
                    )}
                  </InlineStack>
                  <div
                    style={{
                      border: "1px solid #e1e3e5",
                      borderRadius: "8px",
                      overflow: "hidden",
                      backgroundColor: "#fafafa",
                    }}
                  >
                    <img
                      src={compareImage.webpUrl}
                      alt="WebP Optimized"
                      style={{
                        width: "100%",
                        height: "auto",
                        display: "block",
                      }}
                    />
                  </div>
                </BlockStack>
              </div>
            </div>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
