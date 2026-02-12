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
  DataTable,
  Badge,
  InlineStack,
  Modal,
  Box,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import sharp from "sharp";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Get optimization statistics
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
    take: 20,
  });

  // Fetch products with images using media query
  const response = await admin.graphql(
    `#graphql
      query getProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
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
    { variables: { first: 250 } }
  );

  const data = await response.json();
  const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

  // Count total images and new (unoptimized) images
  let totalImages = 0;
  let newImages = 0;

  for (const product of products) {
    const mediaImages = product.media?.edges
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

  // Count reverted images
  const revertedCount = await db.imageOptimization.count({
    where: { shop, status: "completed" },
  });

  return json({
    shop,
    stats,
    recentOptimizations,
    products,
    totalImages,
    newImages,
    revertedCount,
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

  if (actionType === "optimize_new") {
    // Get all products with media
    const response = await admin.graphql(
      `#graphql
        query getProducts($first: Int!) {
          products(first: $first) {
            edges {
              node {
                id
                title
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
      { variables: { first: 250 } }
    );

    const data = await response.json();
    const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

    let processedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let totalSaved = 0;

    for (const product of products) {
      const productId = product.id;
      const mediaImages = product.media?.edges
        ?.map((e: any) => e.node)
        ?.filter((m: any) => m.mediaContentType === "IMAGE") || [];

      for (const media of mediaImages) {
        try {
          // Check if already optimized
          const existing = await db.imageOptimization.findUnique({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
          });

          if (existing && existing.status === "completed") {
            skippedCount++;
            continue;
          }

          // Create or update record as processing
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
              status: "processing",
            },
            update: {
              status: "processing",
            },
          });

          // Download the original image
          const imageResponse = await fetch(media.image.url);
          const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
          const originalSize = imageBuffer.length;

          // Convert to WebP
          const webpBuffer = await sharp(imageBuffer)
            .webp({ quality: 85 })
            .toBuffer();
          const webpSize = webpBuffer.length;

          // Step 1: Create a staged upload for the WebP file
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
                    filename: `optimized-${media.id.split("/").pop()}.webp`,
                    mimeType: "image/webp",
                    httpMethod: "POST",
                  },
                ],
              },
            }
          );

          const stagedData = await stagedUploadResponse.json();
          const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

          if (!target) {
            throw new Error("Failed to create staged upload");
          }

          // Step 2: Upload the WebP file to the staged URL
          const uploadFormData = new FormData();
          for (const param of target.parameters) {
            uploadFormData.append(param.name, param.value);
          }
          uploadFormData.append(
            "file",
            new Blob([webpBuffer], { type: "image/webp" }),
            `optimized-${media.id.split("/").pop()}.webp`
          );

          const uploadResponse = await fetch(target.url, {
            method: "POST",
            body: uploadFormData,
          });

          if (!uploadResponse.ok) {
            throw new Error(`Upload failed: ${uploadResponse.statusText}`);
          }

          // Step 3: Delete the old image from the product
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
            }
          );

          const deleteData = await deleteResponse.json();
          if (deleteData.data?.productDeleteMedia?.mediaUserErrors?.length > 0) {
            console.error("Delete errors:", deleteData.data.productDeleteMedia.mediaUserErrors);
          }

          // Step 4: Add the WebP image to the product
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
                    alt: media.image.altText || "Optimized WebP image",
                    mediaContentType: "IMAGE",
                    originalSource: target.resourceUrl,
                  },
                ],
              },
            }
          );

          const createData = await createMediaResponse.json();
          const newMedia = createData.data?.productCreateMedia?.media?.[0];

          if (createData.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
            throw new Error(
              createData.data.productCreateMedia.mediaUserErrors
                .map((e: any) => e.message)
                .join(", ")
            );
          }

          const savings = originalSize - webpSize;
          totalSaved += savings;

          // Update record with completion
          await db.imageOptimization.update({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
            data: {
              webpUrl: newMedia?.image?.url || target.resourceUrl,
              webpGid: newMedia?.id || null,
              fileSize: originalSize,
              webpFileSize: webpSize,
              status: "completed",
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
      actionType: "optimize",
      processedCount,
      errorCount,
      skippedCount,
      totalSaved,
    });
  }

  if (actionType === "revert_all") {
    // Get all completed optimizations for this shop
    const optimizations = await db.imageOptimization.findMany({
      where: { shop, status: "completed" },
    });

    let revertedCount = 0;
    let errorCount = 0;

    for (const opt of optimizations) {
      try {
        // Step 1: Delete the current WebP image from the product
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
            }
          );
        }

        // Step 2: Re-add the original image from the saved URL
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
              productId: opt.productId,
              media: [
                {
                  alt: "Restored original image",
                  mediaContentType: "IMAGE",
                  originalSource: opt.originalUrl,
                },
              ],
            },
          }
        );

        const createData = await createMediaResponse.json();
        if (createData.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
          throw new Error(
            createData.data.productCreateMedia.mediaUserErrors
              .map((e: any) => e.message)
              .join(", ")
          );
        }

        // Update record as reverted
        await db.imageOptimization.update({
          where: { id: opt.id },
          data: { status: "reverted" },
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

  if (actionType === "revert_single") {
    const optimizationId = formData.get("optimizationId") as string;

    try {
      const opt = await db.imageOptimization.findUnique({
        where: { id: optimizationId },
      });

      if (!opt || opt.status !== "completed") {
        return json({ success: false, message: "Optimization not found or not completed" });
      }

      // Delete the WebP image
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
          }
        );
      }

      // Re-add original
      await admin.graphql(
        `#graphql
          mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
            productCreateMedia(media: $media, productId: $productId) {
              media {
                ... on MediaImage {
                  id
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
                alt: "Restored original image",
                mediaContentType: "IMAGE",
                originalSource: opt.originalUrl,
              },
            ],
          },
        }
      );

      await db.imageOptimization.update({
        where: { id: opt.id },
        data: { status: "reverted" },
      });

      return json({ success: true, actionType: "revert_single" });
    } catch (error) {
      console.error("Error reverting single image:", error);
      return json({ success: false, message: "Failed to revert image" });
    }
  }

  return json({ success: false });
};

export default function ImageOptimizer() {
  const { shop, stats, recentOptimizations, products, totalImages, newImages, revertedCount } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [showRevertModal, setShowRevertModal] = useState(false);

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

  const statsMap = stats.reduce(
    (acc: any, stat: any) => {
      acc[stat.status] = stat._count.status;
      return acc;
    },
    { pending: 0, processing: 0, completed: 0, failed: 0, reverted: 0 }
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

  const tableRows = recentOptimizations.map((opt: any) => [
    opt.imageId.split("/").pop(),
    opt.productId.split("/").pop(),
    <Badge
      tone={
        opt.status === "completed"
          ? "success"
          : opt.status === "failed"
          ? "critical"
          : opt.status === "reverted"
          ? "warning"
          : "info"
      }
      key={opt.id}
    >
      {opt.status}
    </Badge>,
    opt.fileSize ? `${(opt.fileSize / 1024).toFixed(1)} KB` : "-",
    opt.webpFileSize ? `${(opt.webpFileSize / 1024).toFixed(1)} KB` : "-",
    opt.webpFileSize && opt.fileSize
      ? `${(((opt.fileSize - opt.webpFileSize) / opt.fileSize) * 100).toFixed(1)}%`
      : "-",
    opt.status === "completed" ? (
      <Button
        key={`revert-${opt.id}`}
        size="slim"
        onClick={() => handleRevertSingle(opt.id)}
        loading={isReverting}
      >
        Revert
      </Button>
    ) : (
      "-"
    ),
  ]);

  return (
    <Page
      title="Image Optimizer"
      subtitle="Compress product images to WebP for faster loading. Original images are saved and can be restored anytime."
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
                  Processed: {actionData.processedCount} | Skipped: {actionData.skippedCount} |
                  Errors: {actionData.errorCount}
                  {actionData.totalSaved > 0 &&
                    ` | Total saved: ${(actionData.totalSaved / 1024).toFixed(1)} KB`}
                </p>
              </Banner>
            )}

            {actionData?.actionType === "revert" && (
              <Banner tone="success" title="Revert Complete">
                <p>
                  Reverted {actionData.revertedCount} image
                  {actionData.revertedCount !== 1 ? "s" : ""} back to originals.
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
                  If you uploaded new product images, click refresh to detect them.
                </Text>
                <div>
                  <Button onClick={handleRefresh} loading={isRefreshing}>
                    Refresh
                  </Button>
                </div>
              </BlockStack>
            </Card>

            {/* New images banner */}
            {newImages > 0 && (
              <Banner tone="info">
                <p>
                  Found {newImages} new image{newImages !== 1 ? "s" : ""} ready to optimize.
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
                    Optimized: {statsMap.completed} | Failed: {statsMap.failed} | Reverted:{" "}
                    {statsMap.reverted || 0}
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
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Recent optimizations table */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Recent Optimizations
                </Text>
                {tableRows.length > 0 ? (
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                      "text",
                    ]}
                    headings={[
                      "Image ID",
                      "Product ID",
                      "Status",
                      "Original",
                      "WebP",
                      "Savings",
                      "Action",
                    ]}
                    rows={tableRows}
                  />
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
              This will restore all {statsMap.completed} optimized images back to their originals.
              Your WebP versions will be removed from the products.
            </Text>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
