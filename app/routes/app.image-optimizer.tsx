import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
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
} from "@shopify/polaris";
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
    take: 10,
  });

  // Fetch products with images
  const response = await admin.graphql(
    `#graphql
      query getProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              featuredImage {
                id
                url
                altText
              }
              images(first: 10) {
                edges {
                  node {
                    id
                    url
                    altText
                  }
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    image {
                      id
                      url
                      altText
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
    const allImages = [
      ...(product.images?.edges?.map((e: any) => e.node) || []),
    ];

    totalImages += allImages.length;

    for (const image of allImages) {
      const existing = await db.imageOptimization.findUnique({
        where: {
          shop_imageId: {
            shop,
            imageId: image.id,
          },
        },
      });

      if (!existing) {
        newImages++;
      }
    }
  }

  return json({
    shop,
    stats,
    recentOptimizations,
    products,
    totalImages,
    newImages,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const action = formData.get("action");

  if (action === "refresh") {
    // Just reload the page to sync new images
    return json({ success: true, message: "Refreshed" });
  }

  if (action === "optimize_new") {
    // Get all products with images
    const response = await admin.graphql(
      `#graphql
        query getProducts($first: Int!) {
          products(first: $first) {
            edges {
              node {
                id
                images(first: 10) {
                  edges {
                    node {
                      id
                      url
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

    // Process each product's images
    for (const product of products) {
      const productId = product.id;
      const allImages = [
        ...(product.images?.edges?.map((e: any) => e.node) || []),
      ];

      for (const image of allImages) {
        try {
          // Check if already optimized
          const existing = await db.imageOptimization.findUnique({
            where: {
              shop_imageId: {
                shop,
                imageId: image.id,
              },
            },
          });

          if (existing) {
            skippedCount++;
            continue; // Skip already optimized images
          }

          // Create record as processing
          await db.imageOptimization.create({
            data: {
              shop,
              productId,
              imageId: image.id,
              originalUrl: image.url,
              status: "processing",
            },
          });

          // Download and convert image
          const imageResponse = await fetch(image.url);
          const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
          const originalSize = imageBuffer.length;

          // Convert to WebP
          const webpBuffer = await sharp(imageBuffer)
            .webp({ quality: 85 })
            .toBuffer();
          const webpSize = webpBuffer.length;

          // In a real implementation, you would upload this to Shopify Files API
          // or your own CDN. For now, we'll store the data URL
          const webpDataUrl = `data:image/webp;base64,${webpBuffer.toString("base64")}`;

          // Update record with completion
          await db.imageOptimization.update({
            where: {
              shop_imageId: {
                shop,
                imageId: image.id,
              },
            },
            data: {
              webpUrl: webpDataUrl,
              fileSize: originalSize,
              webpFileSize: webpSize,
              status: "completed",
            },
          });

          processedCount++;
        } catch (error) {
          console.error(`Error processing image ${image.id}:`, error);
          errorCount++;

          await db.imageOptimization.upsert({
            where: {
              shop_imageId: {
                shop,
                imageId: image.id,
              },
            },
            create: {
              shop,
              productId,
              imageId: image.id,
              originalUrl: image.url,
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
      processedCount,
      errorCount,
      skippedCount,
    });
  }

  return json({ success: false });
};

export default function ImageOptimizer() {
  const { shop, stats, recentOptimizations, products, totalImages, newImages } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const isOptimizing = navigation.state === "submitting" && 
    navigation.formData?.get("action") === "optimize_new";
  const isRefreshing = navigation.state === "submitting" && 
    navigation.formData?.get("action") === "refresh";

  const statsMap = stats.reduce(
    (acc: any, stat: any) => {
      acc[stat.status] = stat._count.status;
      return acc;
    },
    { pending: 0, processing: 0, completed: 0, failed: 0 }
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

  const tableRows = recentOptimizations.map((opt: any) => [
    opt.imageId.split("/").pop(),
    opt.productId.split("/").pop(),
    <Badge tone={opt.status === "completed" ? "success" : opt.status === "failed" ? "critical" : "info"} key={opt.id}>
      {opt.status}
    </Badge>,
    opt.fileSize ? `${(opt.fileSize / 1024).toFixed(2)} KB` : "-",
    opt.webpFileSize ? `${(opt.webpFileSize / 1024).toFixed(2)} KB` : "-",
    opt.webpFileSize && opt.fileSize
      ? `${(((opt.fileSize - opt.webpFileSize) / opt.fileSize) * 100).toFixed(1)}%`
      : "-",
  ]);

  return (
    <Page
      title="Optimize images"
      subtitle="If you uploaded new images, click refresh to sync new images."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Button
                  onClick={handleRefresh}
                  loading={isRefreshing}
                >
                  Refresh
                </Button>
              </BlockStack>
            </Card>

            {newImages > 0 && (
              <Banner tone="info">
                <Text as="p">
                  Found {newImages} new image{newImages !== 1 ? 's' : ''} ready to optimize.
                </Text>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Optimization Progress
                </Text>
                <ProgressBar
                  progress={completionPercentage}
                  size="small"
                />
                <BlockStack gap="200">
                  <Text as="p">
                    Total images: {totalImages}
                  </Text>
                  <Text as="p">
                    Completed: {statsMap.completed} | Processing: {statsMap.processing} | 
                    Pending: {statsMap.pending} | Failed: {statsMap.failed}
                  </Text>
                  {newImages > 0 && (
                    <Text as="p" tone="success" fontWeight="bold">
                      New images to optimize: {newImages}
                    </Text>
                  )}
                </BlockStack>
                <Button
                  variant="primary"
                  onClick={handleOptimizeNew}
                  size="large"
                  loading={isOptimizing}
                  disabled={newImages === 0}
                >
                  {newImages > 0 
                    ? `Optimize ${newImages} New Image${newImages !== 1 ? 's' : ''}`
                    : "No New Images to Optimize"
                  }
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Recent Optimizations
                </Text>
                {tableRows.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                    headings={[
                      "Image ID",
                      "Product ID",
                      "Status",
                      "Original Size",
                      "WebP Size",
                      "Savings",
                    ]}
                    rows={tableRows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    No optimizations yet. Click "Optimize New Images" to start.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
