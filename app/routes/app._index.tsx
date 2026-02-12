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
  InlineStack,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const totalOptimized = await db.imageOptimization.count({
    where: { shop, status: "completed" },
  });

  const totalImages = await db.imageOptimization.count({
    where: { shop },
  });

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
  };
};

export default function Index() {
  const { shop, totalOptimized, totalImages, totalSavings } =
    useLoaderData<typeof loader>();

  const savingsInKB = (totalSavings / 1024).toFixed(1);
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
                    Welcome to Image Optimizer
                  </Text>
                  <Text variant="bodyMd" as="p">
                    Compress your product images to WebP format for faster page loads
                    and better SEO. Works automatically with any theme - no code changes needed.
                  </Text>
                </BlockStack>

                {totalOptimized === 0 ? (
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="bold">
                        Get started
                      </Text>
                      <Text as="p">
                        Go to the Image Optimizer to scan and optimize your product images.
                        You can revert back to originals at any time.
                      </Text>
                    </BlockStack>
                  </Banner>
                ) : (
                  <Banner tone="success">
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="bold">
                        {totalOptimized} images optimized!
                      </Text>
                      <Text as="p">
                        Total savings: {savingsInMB} MB ({savingsInKB} KB)
                      </Text>
                    </BlockStack>
                  </Banner>
                )}

                <Button url="/app/image-optimizer" variant="primary">
                  Go to Image Optimizer
                </Button>
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
                        Total Tracked
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
                    How It Works
                  </Text>
                  <List type="number">
                    <List.Item>
                      Click Refresh to detect your product images
                    </List.Item>
                    <List.Item>
                      Click Optimize to convert new images to WebP
                    </List.Item>
                    <List.Item>
                      WebP images replace originals on your storefront automatically
                    </List.Item>
                    <List.Item>
                      Original images are saved - revert anytime with one click
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
