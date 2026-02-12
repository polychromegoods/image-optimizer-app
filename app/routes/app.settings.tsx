import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  Text,
  Select,
  TextField,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Settings model would be added to Prisma schema
// For now, we'll use in-memory settings with defaults

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  
  // In a real app, fetch settings from database
  const settings = {
    quality: 85,
    autoOptimize: false,
    maxWidth: 2048,
    maxHeight: 2048,
    preserveMetadata: false,
  };

  return json({ settings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const settings = {
    quality: parseInt(formData.get("quality") as string),
    autoOptimize: formData.get("autoOptimize") === "true",
    maxWidth: parseInt(formData.get("maxWidth") as string),
    maxHeight: parseInt(formData.get("maxHeight") as string),
    preserveMetadata: formData.get("preserveMetadata") === "true",
  };

  // In a real app, save settings to database
  console.log("Saving settings:", settings);

  return json({ success: true, settings });
};

export default function Settings() {
  const { settings: initialSettings } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const [quality, setQuality] = useState(String(initialSettings.quality));
  const [autoOptimize, setAutoOptimize] = useState(initialSettings.autoOptimize);
  const [maxWidth, setMaxWidth] = useState(String(initialSettings.maxWidth));
  const [maxHeight, setMaxHeight] = useState(String(initialSettings.maxHeight));
  const [preserveMetadata, setPreserveMetadata] = useState(
    initialSettings.preserveMetadata
  );

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.append("quality", quality);
    formData.append("autoOptimize", String(autoOptimize));
    formData.append("maxWidth", maxWidth);
    formData.append("maxHeight", maxHeight);
    formData.append("preserveMetadata", String(preserveMetadata));
    
    submit(formData, { method: "post" });
  }, [quality, autoOptimize, maxWidth, maxHeight, preserveMetadata, submit]);

  const qualityOptions = [
    { label: "Low (60)", value: "60" },
    { label: "Medium (75)", value: "75" },
    { label: "High (85)", value: "85" },
    { label: "Very High (95)", value: "95" },
  ];

  return (
    <Page
      title="Settings"
      subtitle="Configure image optimization preferences"
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Compression Settings
                </Text>
                
                <Select
                  label="WebP Quality"
                  options={qualityOptions}
                  value={quality}
                  onChange={setQuality}
                  helpText="Higher quality means larger file sizes but better image quality"
                />

                <BlockStack gap="200">
                  <TextField
                    label="Maximum Width (pixels)"
                    type="number"
                    value={maxWidth}
                    onChange={setMaxWidth}
                    autoComplete="off"
                    helpText="Images wider than this will be resized"
                  />
                  
                  <TextField
                    label="Maximum Height (pixels)"
                    type="number"
                    value={maxHeight}
                    onChange={setMaxHeight}
                    autoComplete="off"
                    helpText="Images taller than this will be resized"
                  />
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Automation
                </Text>
                
                <Checkbox
                  label="Auto-optimize new product images"
                  checked={autoOptimize}
                  onChange={setAutoOptimize}
                  helpText="Automatically convert new product images to WebP when they are uploaded"
                />
                
                <Checkbox
                  label="Preserve image metadata"
                  checked={preserveMetadata}
                  onChange={setPreserveMetadata}
                  helpText="Keep EXIF data and other metadata in optimized images"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Implementation Guide
                </Text>
                
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" fontWeight="bold">
                      To use WebP images on your storefront:
                    </Text>
                    <Text as="p">
                      1. The app automatically converts and stores your product images in WebP format
                    </Text>
                    <Text as="p">
                      2. Original images remain unchanged in your Shopify admin
                    </Text>
                    <Text as="p">
                      3. Use the provided API endpoint to fetch WebP URLs for your theme
                    </Text>
                    <Text as="p">
                      4. Modern browsers will load WebP images, while older browsers fall back to originals
                    </Text>
                  </BlockStack>
                </Banner>

                <Banner tone="warning">
                  <Text as="p">
                    Note: In this demo version, WebP images are stored as data URLs. 
                    For production, you should upload optimized images to Shopify Files API 
                    or a CDN for better performance.
                  </Text>
                </Banner>
              </BlockStack>
            </Card>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="primary" onClick={handleSave}>
                Save Settings
              </Button>
            </div>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
