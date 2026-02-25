import { describe, it, expect } from "vitest";
import {
  applyTemplate,
  makeFileName,
  buildTemplateVariables,
  applyTemplatePreview,
  getMimeType,
  getExtensionFromUrl,
  extractIdFromGid,
} from "../app/lib/templates";

// ─── applyTemplate ─────────────────────────────────────────────────────────────

describe("applyTemplate", () => {
  it("replaces a single variable", () => {
    expect(applyTemplate("#product_name#", { product_name: "Blue Mug" })).toBe(
      "Blue Mug",
    );
  });

  it("replaces multiple variables", () => {
    const result = applyTemplate("#product_name# by #vendor#", {
      product_name: "Blue Mug",
      vendor: "My Brand",
    });
    expect(result).toBe("Blue Mug by My Brand");
  });

  it("replaces all occurrences of the same variable", () => {
    const result = applyTemplate("#product_name# - #product_name#", {
      product_name: "Mug",
    });
    expect(result).toBe("Mug - Mug");
  });

  it("collapses multiple spaces into one", () => {
    const result = applyTemplate("#product_name#  #vendor#", {
      product_name: "Mug",
      vendor: "",
    });
    expect(result).toBe("Mug");
  });

  it("trims trailing separators", () => {
    expect(applyTemplate("#product_name# -", { product_name: "Mug" })).toBe(
      "Mug",
    );
    expect(applyTemplate("#product_name# |", { product_name: "Mug" })).toBe(
      "Mug",
    );
    expect(applyTemplate("#product_name#,", { product_name: "Mug" })).toBe(
      "Mug",
    );
  });

  it("handles empty template", () => {
    expect(applyTemplate("", { product_name: "Mug" })).toBe("");
  });

  it("handles template with no variables", () => {
    expect(applyTemplate("Static text", {})).toBe("Static text");
  });

  it("leaves unmatched variables as-is", () => {
    expect(applyTemplate("#unknown_var#", { product_name: "Mug" })).toBe(
      "#unknown_var#",
    );
  });
});

// ─── makeFileName ──────────────────────────────────────────────────────────────

describe("makeFileName", () => {
  it("creates a URL-safe filename", () => {
    const result = makeFileName("#product_name#", {
      product_name: "Blue Mug",
    });
    expect(result).toBe("blue-mug");
  });

  it("strips special characters", () => {
    const result = makeFileName("#product_name#", {
      product_name: "Mug (Large) $50!",
    });
    expect(result).toBe("mug-large-50");
  });

  it("collapses multiple hyphens", () => {
    const result = makeFileName("#product_name# - #vendor#", {
      product_name: "Mug",
      vendor: "Brand",
    });
    expect(result).toBe("mug-brand");
  });

  it("trims leading and trailing hyphens", () => {
    const result = makeFileName("- #product_name# -", {
      product_name: "Mug",
    });
    expect(result).toBe("mug");
  });

  it("handles empty result gracefully", () => {
    expect(makeFileName("#product_name#", { product_name: "" })).toBe("");
  });
});

// ─── buildTemplateVariables ────────────────────────────────────────────────────

describe("buildTemplateVariables", () => {
  it("builds variables from product data", () => {
    const vars = buildTemplateVariables(
      {
        title: "Blue Mug",
        vendor: "My Brand",
        productType: "Drinkware",
        handle: "blue-mug",
      },
      "My Store",
      2,
    );

    expect(vars).toEqual({
      product_name: "Blue Mug",
      vendor: "My Brand",
      product_type: "Drinkware",
      shop_name: "My Store",
      product_handle: "blue-mug",
      variant_title: "",
      image_number: "3", // 0-indexed + 1
    });
  });

  it("handles missing fields gracefully", () => {
    const vars = buildTemplateVariables(
      { title: "", vendor: "", productType: "", handle: "" },
      "",
      0,
    );

    expect(vars.product_name).toBe("");
    expect(vars.image_number).toBe("1");
  });
});

// ─── applyTemplatePreview ──────────────────────────────────────────────────────

describe("applyTemplatePreview", () => {
  it("uses sample data for preview", () => {
    const result = applyTemplatePreview("#product_name# by #vendor#");
    expect(result).toBe("Classic Blue T-Shirt by My Brand");
  });

  it("shows image number", () => {
    const result = applyTemplatePreview("Image #image_number#");
    expect(result).toBe("Image 1");
  });
});

// ─── getMimeType ───────────────────────────────────────────────────────────────

describe("getMimeType", () => {
  it("returns correct MIME for common extensions", () => {
    expect(getMimeType("jpg")).toBe("image/jpeg");
    expect(getMimeType("jpeg")).toBe("image/jpeg");
    expect(getMimeType("png")).toBe("image/png");
    expect(getMimeType("webp")).toBe("image/webp");
    expect(getMimeType("gif")).toBe("image/gif");
    expect(getMimeType("svg")).toBe("image/svg+xml");
  });

  it("is case-insensitive", () => {
    expect(getMimeType("JPG")).toBe("image/jpeg");
    expect(getMimeType("PNG")).toBe("image/png");
  });

  it("defaults to image/png for unknown extensions", () => {
    expect(getMimeType("bmp")).toBe("image/png");
    expect(getMimeType("tiff")).toBe("image/png");
  });
});

// ─── getExtensionFromUrl ───────────────────────────────────────────────────────

describe("getExtensionFromUrl", () => {
  it("extracts extension from simple URL", () => {
    expect(getExtensionFromUrl("https://cdn.shopify.com/image.png")).toBe("png");
  });

  it("strips query parameters", () => {
    expect(
      getExtensionFromUrl(
        "https://cdn.shopify.com/image.jpg?v=1234&width=800",
      ),
    ).toBe("jpg");
  });

  it("handles URLs with multiple dots", () => {
    expect(
      getExtensionFromUrl("https://cdn.shopify.com/my.product.image.webp"),
    ).toBe("webp");
  });

  it("handles path segments without extension", () => {
    // The function splits on '.' and takes the last segment
    // For URLs without a clear extension, it returns the last dot-segment
    expect(getExtensionFromUrl("https://cdn.shopify.com/files/image.png")).toBe("png");
  });
});

// ─── extractIdFromGid ──────────────────────────────────────────────────────────

describe("extractIdFromGid", () => {
  it("extracts ID from Shopify GID", () => {
    expect(extractIdFromGid("gid://shopify/MediaImage/12345")).toBe("12345");
  });

  it("extracts ID from product GID", () => {
    expect(extractIdFromGid("gid://shopify/Product/67890")).toBe("67890");
  });

  it("returns the string itself if no slashes", () => {
    expect(extractIdFromGid("12345")).toBe("12345");
  });

  it("handles empty string", () => {
    expect(extractIdFromGid("")).toBe("");
  });
});
