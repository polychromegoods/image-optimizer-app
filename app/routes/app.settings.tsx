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
  TextField,
  Banner,
  InlineStack,
  Tag,
  Divider,
  Checkbox,
  Box,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const TEMPLATE_VARIABLES = [
  { label: "#product_name#", description: "Product title" },
  { label: "#vendor#", description: "Product vendor" },
  { label: "#product_type#", description: "Product type" },
  { label: "#shop_name#", description: "Shop name" },
  { label: "#product_handle#", description: "URL-friendly product handle" },
  { label: "#variant_title#", description: "Variant title (if applicable)" },
  { label: "#image_number#", description: "Image position number (1, 2, 3...)" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let seoSettings = await db.seoSettings.findUnique({
    where: { shop },
  });

  if (!seoSettings) {
    seoSettings = await db.seoSettings.create({
      data: {
        shop,
        altTextTemplate: "#product_name#",
        fileNameTemplate: "#product_name#",
        autoApplyOnOptimize: true,
      },
    });
  }

  return json({ seoSettings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("action");

  if (actionType === "save_seo") {
    const altTextTemplate = formData.get("altTextTemplate") as string;
    const fileNameTemplate = formData.get("fileNameTemplate") as string;
    const autoApplyOnOptimize = formData.get("autoApplyOnOptimize") === "true";

    await db.seoSettings.upsert({
      where: { shop },
      create: {
        shop,
        altTextTemplate,
        fileNameTemplate,
        autoApplyOnOptimize,
      },
      update: {
        altTextTemplate,
        fileNameTemplate,
        autoApplyOnOptimize,
      },
    });

    return json({ success: true, actionType: "save_seo" });
  }

  if (actionType === "apply_seo_now") {
    // Get SEO settings
    const seoSettings = await db.seoSettings.findUnique({
      where: { shop },
    });

    if (!seoSettings) {
      return json({ success: false, message: "No SEO settings found" });
    }

    // Get shop info
    const shopResponse = await admin.graphql(
      `#graphql
        query {
          shop {
            name
          }
        }
      `
    );
    const shopData = await shopResponse.json();
    const shopName = shopData.data?.shop?.name || shop;

    // Get all products with media
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

    let updatedCount = 0;
    let errorCount = 0;

    for (const product of products) {
      const mediaImages = product.media?.edges
        ?.map((e: any) => e.node)
        ?.filter((m: any) => m.mediaContentType === "IMAGE") || [];

      for (let i = 0; i < mediaImages.length; i++) {
        const media = mediaImages[i];

        try {
          // Build alt text from template
          const altText = applyTemplate(seoSettings.altTextTemplate, {
            product_name: product.title,
            vendor: product.vendor || "",
            product_type: product.productType || "",
            shop_name: shopName,
            product_handle: product.handle,
            variant_title: "",
            image_number: String(i + 1),
          });

          // Update alt text via productUpdateMedia
          const updateResponse = await admin.graphql(
            `#graphql
              mutation productUpdateMedia($media: [UpdateMediaInput!]!, $productId: ID!) {
                productUpdateMedia(media: $media, productId: $productId) {
                  media {
                    ... on MediaImage {
                      id
                      image {
                        altText
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
                productId: product.id,
                media: [
                  {
                    id: media.id,
                    alt: altText,
                  },
                ],
              },
            }
          );

          const updateData = await updateResponse.json();
          if (updateData.data?.productUpdateMedia?.mediaUserErrors?.length > 0) {
            throw new Error(
              updateData.data.productUpdateMedia.mediaUserErrors
                .map((e: any) => e.message)
                .join(", ")
            );
          }

          // Save original alt text for potential revert
          await db.imageOptimization.upsert({
            where: {
              shop_imageId: {
                shop,
                imageId: media.id,
              },
            },
            create: {
              shop,
              productId: product.id,
              imageId: media.id,
              originalUrl: media.image?.url || "",
              originalGid: media.id,
              originalAlt: media.image?.altText || "",
              altTextUpdated: true,
              status: "pending",
            },
            update: {
              originalAlt: media.image?.altText || "",
              altTextUpdated: true,
            },
          });

          updatedCount++;
        } catch (error) {
          console.error(`Error updating alt text for ${media.id}:`, error);
          errorCount++;
        }
      }
    }

    return json({
      success: true,
      actionType: "apply_seo",
      updatedCount,
      errorCount,
    });
  }

  return json({ success: false });
};

function applyTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`#${key}#`, "g"), value);
  }
  // Clean up: trim, collapse spaces, remove trailing separators
  result = result.replace(/\s+/g, " ").trim();
  result = result.replace(/[-_|,]\s*$/, "").trim();
  return result;
}

export default function Settings() {
  const { seoSettings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [altTextTemplate, setAltTextTemplate] = useState(
    seoSettings.altTextTemplate
  );
  const [fileNameTemplate, setFileNameTemplate] = useState(
    seoSettings.fileNameTemplate
  );
  const [autoApplyOnOptimize, setAutoApplyOnOptimize] = useState(
    seoSettings.autoApplyOnOptimize
  );

  const isSaving =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "save_seo";
  const isApplying =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "apply_seo_now";

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.append("action", "save_seo");
    formData.append("altTextTemplate", altTextTemplate);
    formData.append("fileNameTemplate", fileNameTemplate);
    formData.append("autoApplyOnOptimize", String(autoApplyOnOptimize));
    submit(formData, { method: "post" });
  }, [altTextTemplate, fileNameTemplate, autoApplyOnOptimize, submit]);

  const handleApplyNow = useCallback(() => {
    const formData = new FormData();
    formData.append("action", "apply_seo_now");
    submit(formData, { method: "post" });
  }, [submit]);

  const insertVariable = (
    variable: string,
    setter: (val: string) => void,
    currentValue: string
  ) => {
    setter(currentValue ? `${currentValue} ${variable}` : variable);
  };

  // Preview with sample data
  const previewAlt = applyTemplatePreview(altTextTemplate);
  const previewFileName = applyTemplatePreview(fileNameTemplate)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  return (
    <Page
      title="Alt Text & File Name Optimization"
      subtitle="Search engines use ALT text for SEO benefits and better image results."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {actionData?.actionType === "save_seo" && actionData?.success && (
              <Banner tone="success" title="Settings Saved">
                <p>Your SEO templates have been saved. They will be applied during the next optimization.</p>
              </Banner>
            )}

            {actionData?.actionType === "apply_seo" && (
              <Banner
                tone={actionData.errorCount > 0 ? "warning" : "success"}
                title="Alt Text Updated"
              >
                <p>
                  Updated {actionData.updatedCount} image{actionData.updatedCount !== 1 ? "s" : ""}.
                  {actionData.errorCount > 0 && ` Errors: ${actionData.errorCount}`}
                </p>
              </Banner>
            )}

            {/* Alt Text Template */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Alt Text Template
                </Text>
                <TextField
                  label=""
                  value={altTextTemplate}
                  onChange={setAltTextTemplate}
                  autoComplete="off"
                  placeholder="#product_name#"
                  connectedRight={
                    <Button onClick={() => setAltTextTemplate("")}>Clear</Button>
                  }
                />
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Template Variables
                  </Text>
                  <InlineStack gap="200" wrap>
                    {TEMPLATE_VARIABLES.map((v) => (
                      <Tag
                        key={`alt-${v.label}`}
                        onClick={() =>
                          insertVariable(v.label, setAltTextTemplate, altTextTemplate)
                        }
                      >
                        {v.label}
                      </Tag>
                    ))}
                  </InlineStack>
                </BlockStack>
                {altTextTemplate && (
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Preview: <strong>{previewAlt}</strong>
                    </Text>
                  </Box>
                )}
              </BlockStack>
            </Card>

            {/* File Name Template */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  File Name Template
                </Text>
                <TextField
                  label=""
                  value={fileNameTemplate}
                  onChange={setFileNameTemplate}
                  autoComplete="off"
                  placeholder="#product_name#"
                  connectedRight={
                    <Button onClick={() => setFileNameTemplate("")}>Clear</Button>
                  }
                />
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Template Variables
                  </Text>
                  <InlineStack gap="200" wrap>
                    {TEMPLATE_VARIABLES.map((v) => (
                      <Tag
                        key={`file-${v.label}`}
                        onClick={() =>
                          insertVariable(v.label, setFileNameTemplate, fileNameTemplate)
                        }
                      >
                        {v.label}
                      </Tag>
                    ))}
                  </InlineStack>
                </BlockStack>
                {fileNameTemplate && (
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Preview: <strong>{previewFileName}.webp</strong>
                    </Text>
                  </Box>
                )}
              </BlockStack>
            </Card>

            {/* Options */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Options
                </Text>
                <Checkbox
                  label="Automatically apply alt text and filenames when optimizing images"
                  checked={autoApplyOnOptimize}
                  onChange={setAutoApplyOnOptimize}
                  helpText="When enabled, alt text and filenames are set automatically during image optimization."
                />
              </BlockStack>
            </Card>

            {/* Action buttons */}
            <InlineStack gap="300" align="end">
              <Button
                onClick={handleApplyNow}
                loading={isApplying}
              >
                Apply Alt Text to All Images Now
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                loading={isSaving}
              >
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Why Alt Text Matters
                </Text>
                <Text as="p" variant="bodySm">
                  Search engines use alt text to understand what an image shows.
                  Well-written alt text improves your image search rankings and
                  makes your store more accessible.
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Tips
                </Text>
                <Text as="p" variant="bodySm">
                  Use descriptive templates that include your product name and type.
                  For example: <strong>#product_name# - #product_type# by #vendor#</strong>
                </Text>
                <Text as="p" variant="bodySm">
                  File names should be URL-friendly. Spaces are automatically
                  converted to hyphens and special characters are removed.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function applyTemplatePreview(template: string): string {
  const sampleData: Record<string, string> = {
    product_name: "Classic Cotton T-Shirt",
    vendor: "Polychrome Goods",
    product_type: "Apparel",
    shop_name: "My Store",
    product_handle: "classic-cotton-t-shirt",
    variant_title: "Large / Blue",
    image_number: "1",
  };

  let result = template;
  for (const [key, value] of Object.entries(sampleData)) {
    result = result.replace(new RegExp(`#${key}#`, "g"), value);
  }
  return result.replace(/\s+/g, " ").trim();
}
