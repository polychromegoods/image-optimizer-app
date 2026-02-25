import type { TemplateVariables } from "./types";

/**
 * Replace template placeholders like `#product_name#` with actual values.
 * Collapses whitespace and trims trailing separators.
 */
export function applyTemplate(
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

/**
 * Generate a URL-safe file name from a template and variables.
 * Lowercases, replaces spaces with hyphens, strips non-alphanumeric characters.
 */
export function makeFileName(
  template: string,
  variables: Record<string, string>,
): string {
  const result = applyTemplate(template, variables);
  return result
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build template variables from a Shopify product and image index.
 */
export function buildTemplateVariables(
  product: { title: string; vendor: string; productType: string; handle: string },
  shopName: string,
  imageIndex: number,
): TemplateVariables {
  return {
    product_name: product.title || "",
    vendor: product.vendor || "",
    product_type: product.productType || "",
    shop_name: shopName,
    product_handle: product.handle || "",
    variant_title: "",
    image_number: String(imageIndex + 1),
  };
}

/**
 * Preview a template with sample data (for the settings page).
 */
export function applyTemplatePreview(template: string): string {
  return applyTemplate(template, {
    product_name: "Classic Blue T-Shirt",
    vendor: "My Brand",
    product_type: "Apparel",
    shop_name: "My Store",
    product_handle: "classic-blue-t-shirt",
    variant_title: "Large",
    image_number: "1",
  });
}

/**
 * Determine the MIME type from a file extension.
 */
export function getMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "png":
    default:
      return "image/png";
  }
}

/**
 * Extract the file extension from a URL (ignoring query params).
 */
export function getExtensionFromUrl(url: string): string {
  return url.split("?")[0].split(".").pop() || "png";
}

/**
 * Extract the trailing ID segment from a Shopify GID string.
 * e.g., "gid://shopify/MediaImage/12345" -> "12345"
 */
export function extractIdFromGid(gid: string): string {
  return gid.split("/").pop() || gid;
}
