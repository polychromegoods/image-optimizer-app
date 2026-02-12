import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  List,
  Link,
  InlineStack,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Get optimization statistics
  const totalOptimized = await db.imageOptimization.count({
    where: { shop, status: "completed" },
  });

  const totalImages = await db.imageOptimization.count({
    where: { shop },
  });

  const recentOptimizations = await db.imageOptimization.findMany({
    where: { shop, status: "completed" },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });

  // Calculate total savings
  const optimizations = await db.imageOptimization.findMany({
    where: { shop, status: "completed" },
    select: { fileSize: true, webpFileSize: true },
  });

  const totalSavings = optimizations.reduce((sum, opt) => {
    if (opt.fileSize && opt.webpFileSize) {
      return sum + (opt.fileSize - opt.webpFileSize);
    }
    return sum;
  }, 0);

  return {
    shop,
    totalOptimized,
    totalImages,
    totalSavings,
    recentOptimizations,
  };
};

export default function Index() {
  const { shop, totalOptimized, totalImages, totalSavings, recentOptimizations } =
    useLoaderData<typeof loader>();

  const savingsInKB = (totalSavings / 1024).toFixed(2);
  const savingsInMB = (totalSavings / 1024 / 1024).toFixed(2);

  return (
    <Page>
      <TitleBar title="Image Optimizer Dashboard" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Welcome to Image Optimizer 🚀
                  </Text>
                  <Text variant="bodyMd" as="p">
                    This app helps you optimize your product images by converting them
                    to WebP format, which provides better compression and faster loading
                    times while maintaining visual quality. The original images are
                    preserved in the backend for compatibility.
                  </Text>
                </BlockStack>

                {totalOptimized === 0 ? (
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="bold">
                        Get started by optimizing your images
                      </Text>
                      <Text as="p">
                        Click the button below to navigate to the Image Optimizer and
                        start converting your product images to WebP format.
                      </Text>
                    </BlockStack>
                  </Banner>
                ) : (
                  <Banner tone="success">
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="bold">
                        You've optimized {totalOptimized} images!
                      </Text>
                      <Text as="p">
                        Total savings: {savingsInMB} MB ({savingsInKB} KB)
                      </Text>
                    </BlockStack>
                  </Banner>
                )}

                <InlineStack gap="300">
                  <Button
                    url="/app/image-optimizer"
                    variant="primary"
                  >
                    Go to Image Optimizer
                  </Button>
                  <Button
                    url="/app/settings"
                    variant="secondary"
                  >
                    Configure Settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Statistics
                  </Text>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Images Optimized
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="bold">
                        {totalOptimized}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Total Images
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="bold">
                        {totalImages}
                      </Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Total Savings
                      </Text>
                      <Text as="span" variant="bodyMd" fontWeight="bold">
                        {savingsInMB} MB
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Features
                  </Text>
                  <List>
                    <List.Item>
                      Convert product images to WebP format
                    </List.Item>
                    <List.Item>
                      Preserve original images in the backend
                    </List.Item>
                    <List.Item>
                      Automatic compression with quality control
                    </List.Item>
                    <List.Item>
                      Track optimization progress and savings
                    </List.Item>
                    <List.Item>
                      API endpoint for theme integration
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    How It Works
                  </Text>
                  <List type="number">
                    <List.Item>
                      Click "Optimize All Images" to start conversion
                    </List.Item>
                    <List.Item>
                      Images are downloaded and converted to WebP
                    </List.Item>
                    <List.Item>
                      Optimized images are stored for fast access
                    </List.Item>
                    <List.Item>
                      Use the API to serve WebP images on your storefront
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
