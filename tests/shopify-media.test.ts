import { describe, it, expect } from "vitest";
import { getProductImages, parseProductsResponse } from "../app/lib/shopify-media";
import type { ShopifyProduct, ShopifyMediaImage } from "../app/lib/types";

// ─── getProductImages ──────────────────────────────────────────────────────────

describe("getProductImages", () => {
  it("extracts IMAGE-type media from a product", () => {
    const product: ShopifyProduct = {
      id: "gid://shopify/Product/1",
      title: "Test Product",
      handle: "test-product",
      vendor: "Test Vendor",
      productType: "Test Type",
      media: {
        edges: [
          {
            node: {
              id: "gid://shopify/MediaImage/100",
              image: { url: "https://cdn.shopify.com/img1.png", altText: "Alt 1", width: 800, height: 600 },
              mediaContentType: "IMAGE",
            },
          },
          {
            node: {
              id: "gid://shopify/MediaImage/101",
              image: { url: "https://cdn.shopify.com/img2.png", altText: null, width: 1024, height: 768 },
              mediaContentType: "IMAGE",
            },
          },
          {
            node: {
              id: "gid://shopify/Video/200",
              image: { url: "", altText: null, width: 0, height: 0 },
              mediaContentType: "VIDEO",
            } as unknown as ShopifyMediaImage,
          },
        ],
      },
    };

    const images = getProductImages(product);
    expect(images).toHaveLength(2);
    expect(images[0].id).toBe("gid://shopify/MediaImage/100");
    expect(images[1].id).toBe("gid://shopify/MediaImage/101");
  });

  it("returns empty array when product has no media", () => {
    const product: ShopifyProduct = {
      id: "gid://shopify/Product/2",
      title: "Empty Product",
      handle: "empty",
      vendor: "",
      productType: "",
      media: { edges: [] },
    };

    expect(getProductImages(product)).toEqual([]);
  });

  it("returns empty array when media edges is undefined", () => {
    const product = {
      id: "gid://shopify/Product/3",
      title: "Broken Product",
      handle: "broken",
      vendor: "",
      productType: "",
      media: {},
    } as unknown as ShopifyProduct;

    expect(getProductImages(product)).toEqual([]);
  });
});

// ─── parseProductsResponse ─────────────────────────────────────────────────────

describe("parseProductsResponse", () => {
  it("parses a standard Shopify GraphQL products response with pageInfo", () => {
    const data = {
      data: {
        products: {
          edges: [
            {
              node: {
                id: "gid://shopify/Product/1",
                title: "Product A",
                handle: "product-a",
                vendor: "Vendor A",
                productType: "Type A",
                media: { edges: [] },
              },
            },
            {
              node: {
                id: "gid://shopify/Product/2",
                title: "Product B",
                handle: "product-b",
                vendor: "Vendor B",
                productType: "Type B",
                media: { edges: [] },
              },
            },
          ],
          pageInfo: {
            hasNextPage: true,
            endCursor: "cursor123",
          },
        },
      },
    };

    const result = parseProductsResponse(data);
    expect(result.products).toHaveLength(2);
    expect(result.products[0].title).toBe("Product A");
    expect(result.products[1].title).toBe("Product B");
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.endCursor).toBe("cursor123");
  });

  it("returns empty products and default pageInfo for empty response", () => {
    const defaultPageInfo = { hasNextPage: false, endCursor: null };
    expect(parseProductsResponse({}).products).toEqual([]);
    expect(parseProductsResponse({}).pageInfo).toEqual(defaultPageInfo);
    expect(parseProductsResponse({ data: {} }).products).toEqual([]);
    expect(parseProductsResponse({ data: { products: {} } }).products).toEqual([]);
    expect(parseProductsResponse({ data: { products: { edges: [] } } }).products).toEqual([]);
  });

  it("returns empty products for null data", () => {
    expect(parseProductsResponse({ data: null } as unknown as Record<string, unknown>).products).toEqual([]);
  });
});
