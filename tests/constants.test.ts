import { describe, it, expect } from "vitest";
import {
  WEBP_QUALITY,
  MAX_PRODUCTS_PER_QUERY,
  MAX_MEDIA_PER_PRODUCT,
  RECENT_OPTIMIZATIONS_LIMIT,
  POLLING_INTERVAL_MS,
  QUERY_PRODUCTS_WITH_MEDIA,
  QUERY_SHOP_NAME,
  MUTATION_STAGED_UPLOADS_CREATE,
  MUTATION_FILE_CREATE,
  MUTATION_PRODUCT_DELETE_MEDIA,
  MUTATION_PRODUCT_CREATE_MEDIA,
  MUTATION_PRODUCT_UPDATE_MEDIA,
} from "../app/lib/constants";

describe("Configuration constants", () => {
  it("WEBP_QUALITY is within valid range (1-100)", () => {
    expect(WEBP_QUALITY).toBeGreaterThanOrEqual(1);
    expect(WEBP_QUALITY).toBeLessThanOrEqual(100);
  });

  it("MAX_PRODUCTS_PER_QUERY is a positive integer", () => {
    expect(MAX_PRODUCTS_PER_QUERY).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_PRODUCTS_PER_QUERY)).toBe(true);
  });

  it("MAX_MEDIA_PER_PRODUCT is a positive integer", () => {
    expect(MAX_MEDIA_PER_PRODUCT).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_MEDIA_PER_PRODUCT)).toBe(true);
  });

  it("RECENT_OPTIMIZATIONS_LIMIT is a positive integer", () => {
    expect(RECENT_OPTIMIZATIONS_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(RECENT_OPTIMIZATIONS_LIMIT)).toBe(true);
  });

  it("POLLING_INTERVAL_MS is at least 1 second", () => {
    expect(POLLING_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe("GraphQL queries and mutations are well-formed strings", () => {
  it("QUERY_PRODUCTS_WITH_MEDIA contains required fields", () => {
    expect(QUERY_PRODUCTS_WITH_MEDIA).toContain("products");
    expect(QUERY_PRODUCTS_WITH_MEDIA).toContain("media");
    expect(QUERY_PRODUCTS_WITH_MEDIA).toContain("MediaImage");
    expect(QUERY_PRODUCTS_WITH_MEDIA).toContain("url");
    expect(QUERY_PRODUCTS_WITH_MEDIA).toContain("altText");
  });

  it("QUERY_SHOP_NAME queries the shop name", () => {
    expect(QUERY_SHOP_NAME).toContain("shop");
    expect(QUERY_SHOP_NAME).toContain("name");
  });

  it("MUTATION_STAGED_UPLOADS_CREATE is a mutation", () => {
    expect(MUTATION_STAGED_UPLOADS_CREATE).toContain("mutation");
    expect(MUTATION_STAGED_UPLOADS_CREATE).toContain("stagedUploadsCreate");
  });

  it("MUTATION_FILE_CREATE is a mutation", () => {
    expect(MUTATION_FILE_CREATE).toContain("mutation");
    expect(MUTATION_FILE_CREATE).toContain("fileCreate");
  });

  it("MUTATION_PRODUCT_DELETE_MEDIA is a mutation", () => {
    expect(MUTATION_PRODUCT_DELETE_MEDIA).toContain("mutation");
    expect(MUTATION_PRODUCT_DELETE_MEDIA).toContain("productDeleteMedia");
  });

  it("MUTATION_PRODUCT_CREATE_MEDIA is a mutation", () => {
    expect(MUTATION_PRODUCT_CREATE_MEDIA).toContain("mutation");
    expect(MUTATION_PRODUCT_CREATE_MEDIA).toContain("productCreateMedia");
  });

  it("MUTATION_PRODUCT_UPDATE_MEDIA is a mutation", () => {
    expect(MUTATION_PRODUCT_UPDATE_MEDIA).toContain("mutation");
    expect(MUTATION_PRODUCT_UPDATE_MEDIA).toContain("productUpdateMedia");
  });
});
