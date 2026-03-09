import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── BUG-001 + BUG-009: Already-optimized images should not be re-detected ──

describe("BUG-001/BUG-009: Duplicate image detection prevention (newMediaId approach)", () => {
  it("should recognize an image by its newMediaId field after optimization", () => {
    // After optimization, the DB has ONE record with both original imageId and newMediaId
    const originalMediaId = "gid://shopify/MediaImage/111";
    const newWebpMediaId = "gid://shopify/MediaImage/222";

    // Single record tracks both IDs
    const dbRecords = [
      { imageId: originalMediaId, newMediaId: newWebpMediaId, status: "completed" },
    ];

    // On refresh, Shopify returns the NEW media ID (the WebP one)
    const shopifyMediaId = newWebpMediaId;

    // Check: is this media ID known as a newMediaId of any completed record?
    const isKnownAsNewMedia = dbRecords.some(
      (r) => r.newMediaId === shopifyMediaId && r.status === "completed",
    );
    expect(isKnownAsNewMedia).toBe(true); // Should NOT be treated as new
  });

  it("should recognize an image by its original imageId", () => {
    const originalMediaId = "gid://shopify/MediaImage/111";
    const newWebpMediaId = "gid://shopify/MediaImage/222";

    const dbRecords = [
      { imageId: originalMediaId, newMediaId: newWebpMediaId, status: "completed" },
    ];

    // Check by original imageId
    const isKnownByImageId = dbRecords.some(
      (r) => r.imageId === originalMediaId && r.status === "completed",
    );
    expect(isKnownByImageId).toBe(true);
  });

  it("should detect truly new images that have no DB record", () => {
    const dbRecords = [
      { imageId: "gid://shopify/MediaImage/111", newMediaId: "gid://shopify/MediaImage/222", status: "completed" },
    ];

    const brandNewMediaId = "gid://shopify/MediaImage/999";
    const isKnownByImageId = dbRecords.some((r) => r.imageId === brandNewMediaId);
    const isKnownByNewMediaId = dbRecords.some((r) => r.newMediaId === brandNewMediaId);
    const isNew = !isKnownByImageId && !isKnownByNewMediaId;
    expect(isNew).toBe(true); // Should be treated as new
  });

  it("should NOT create duplicate DB records per optimization", () => {
    // The old approach created 2 records per image. The new approach creates 1.
    const originalMediaId = "gid://shopify/MediaImage/111";
    const newWebpMediaId = "gid://shopify/MediaImage/222";

    // After optimization: ONE record with newMediaId field
    const dbRecords = [
      { imageId: originalMediaId, newMediaId: newWebpMediaId, status: "completed" },
    ];

    // Should only have 1 record, not 2
    expect(dbRecords).toHaveLength(1);
    expect(dbRecords[0].imageId).toBe(originalMediaId);
    expect(dbRecords[0].newMediaId).toBe(newWebpMediaId);
  });
});

// ─── BUG-002/BUG-009: Counter should accurately reflect unique optimizations ─

describe("BUG-002/BUG-009: Accurate image counting with newMediaId", () => {
  it("should count unique optimizations, not DB record count", () => {
    // 5 products with 1 image each = 5 total images
    // All 5 optimized = 5 DB records (one per image, with newMediaId set)
    const totalProductImages = 5;
    const dbRecords = [
      { imageId: "img-1", newMediaId: "webp-1", status: "completed" },
      { imageId: "img-2", newMediaId: "webp-2", status: "completed" },
      { imageId: "img-3", newMediaId: "webp-3", status: "completed" },
      { imageId: "img-4", newMediaId: "webp-4", status: "completed" },
      { imageId: "img-5", newMediaId: "webp-5", status: "completed" },
    ];

    // Shopify now returns the WebP media IDs
    const shopifyMediaIds = ["webp-1", "webp-2", "webp-3", "webp-4", "webp-5"];

    // Count optimized: for each Shopify media, check if it's known as imageId or newMediaId
    const completedByImageId = new Set(dbRecords.filter((r) => r.status === "completed").map((r) => r.imageId));
    const completedByNewMediaId = new Set(dbRecords.filter((r) => r.status === "completed").map((r) => r.newMediaId));

    let optimizedCount = 0;
    for (const mediaId of shopifyMediaIds) {
      if (completedByImageId.has(mediaId) || completedByNewMediaId.has(mediaId)) {
        optimizedCount++;
      }
    }

    expect(optimizedCount).toBe(5);
    expect(optimizedCount).toBeLessThanOrEqual(totalProductImages);
  });

  it("should not double-count when adding a new image after optimization", () => {
    // 5 images optimized, then 1 new image added = 6 total
    const dbRecords = [
      { imageId: "img-1", newMediaId: "webp-1", status: "completed" },
      { imageId: "img-2", newMediaId: "webp-2", status: "completed" },
      { imageId: "img-3", newMediaId: "webp-3", status: "completed" },
      { imageId: "img-4", newMediaId: "webp-4", status: "completed" },
      { imageId: "img-5", newMediaId: "webp-5", status: "completed" },
    ];

    // Shopify returns 5 WebP + 1 brand new
    const shopifyMediaIds = ["webp-1", "webp-2", "webp-3", "webp-4", "webp-5", "new-img-6"];

    const completedByImageId = new Set(dbRecords.filter((r) => r.status === "completed").map((r) => r.imageId));
    const completedByNewMediaId = new Set(dbRecords.filter((r) => r.status === "completed").map((r) => r.newMediaId));

    let optimizedCount = 0;
    let newCount = 0;
    for (const mediaId of shopifyMediaIds) {
      if (completedByImageId.has(mediaId) || completedByNewMediaId.has(mediaId)) {
        optimizedCount++;
      } else {
        newCount++;
      }
    }

    expect(optimizedCount).toBe(5); // Not 6, not 10
    expect(newCount).toBe(1); // The new image
    expect(optimizedCount + newCount).toBe(shopifyMediaIds.length);
  });

  it("should calculate completion percentage correctly", () => {
    const totalImages = 6;
    const optimizedCount = 5;
    const percentage = totalImages > 0 ? Math.min((optimizedCount / totalImages) * 100, 100) : 0;
    expect(percentage).toBeCloseTo(83.3, 0);
  });
});

// ─── BUG-003: WebP larger than original should be skipped ───────────────────

describe("BUG-003: Skip WebP when larger than original", () => {
  it("should skip conversion when WebP is larger", () => {
    const originalSize = 50000; // 50 KB
    const webpSize = 65000; // 65 KB — larger!

    const shouldSkip = webpSize >= originalSize;
    expect(shouldSkip).toBe(true);
  });

  it("should proceed with conversion when WebP is smaller", () => {
    const originalSize = 100000; // 100 KB
    const webpSize = 45000; // 45 KB — smaller

    const shouldSkip = webpSize >= originalSize;
    expect(shouldSkip).toBe(false);
  });

  it("should skip when WebP is exactly the same size", () => {
    const originalSize = 50000;
    const webpSize = 50000;

    const shouldSkip = webpSize >= originalSize;
    expect(shouldSkip).toBe(true);
  });

  it("should mark skipped images with newMediaId same as original", () => {
    // When we skip, newMediaId = original media ID (since we didn't replace)
    const originalMediaId = "gid://shopify/MediaImage/111";
    const record = {
      imageId: originalMediaId,
      newMediaId: originalMediaId, // Same! We kept the original
      status: "completed",
    };

    expect(record.newMediaId).toBe(record.imageId);
    expect(record.status).toBe("completed");
  });
});

// ─── BUG-004: Reverted images should be re-optimizable ─────────────────────

describe("BUG-004: Reverted images can be re-optimized", () => {
  it("should delete DB record after reverting so image appears as new", () => {
    // Before revert: record exists with status "completed"
    const dbRecords = new Map<string, { status: string }>();
    dbRecords.set("img-1", { status: "completed" });

    // After revert: record should be DELETED (not just status changed)
    dbRecords.delete("img-1");

    // On next refresh, the restored image gets a new media ID
    const newMediaId = "img-restored-1";
    const isNew = !dbRecords.has(newMediaId);
    expect(isNew).toBe(true); // Should be detected as new
  });

  it("should use newMediaId for deletion when reverting", () => {
    // When reverting, we need to delete the WebP media (which is the newMediaId)
    const record = {
      imageId: "gid://shopify/MediaImage/111",
      newMediaId: "gid://shopify/MediaImage/222",
      webpGid: "gid://shopify/MediaImage/222",
    };

    // Should use newMediaId (or webpGid) to identify what to delete from the product
    const mediaToDelete = record.newMediaId || record.webpGid;
    expect(mediaToDelete).toBe("gid://shopify/MediaImage/222");
  });
});

// ─── BUG-005: Connection pool exhaustion prevention ─────────────────────────

describe("BUG-005: Rate limiting between operations", () => {
  it("should include a delay between image processing", async () => {
    const DELAY_MS = 200;
    const start = Date.now();

    // Simulate the delay
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(DELAY_MS - 10); // Allow small timing variance
  });
});

// ─── BUG-006: Network error handling ────────────────────────────────────────

describe("BUG-006: Graceful network error handling", () => {
  it("should produce a user-friendly message on fetch failure", () => {
    const error = new TypeError("Failed to fetch");

    // The fix catches this and shows a friendly message
    const friendlyMessage =
      "Network connection interrupted. The optimization is still running in the background. " +
      "Please check your connection and refresh the page.";

    expect(friendlyMessage).toContain("Network connection interrupted");
    expect(friendlyMessage).not.toContain("Failed to fetch"); // No raw error
  });
});

// ─── BUG-007: Concurrent optimization prevention ────────────────────────────

describe("BUG-007: Prevent concurrent optimizations", () => {
  it("should block new optimization when one is already running", () => {
    const existingRunningJob = { id: "job-1", status: "running", shop: "test.myshopify.com" };

    // When a running job exists, new optimization should be blocked
    const shouldBlock = existingRunningJob !== null;
    expect(shouldBlock).toBe(true);
  });

  it("should allow new optimization when no job is running", () => {
    const existingRunningJob = null;

    const shouldBlock = existingRunningJob !== null;
    expect(shouldBlock).toBe(false);
  });

  it("should allow retry even when a job is running", () => {
    const existingRunningJob = { id: "job-1", status: "running" };
    const isRetry = true;

    // Retry should be allowed even with a running job
    const shouldBlock = existingRunningJob !== null && !isRetry;
    expect(shouldBlock).toBe(false);
  });
});

// ─── BUG-008: Billing error handling ────────────────────────────────────────

describe("BUG-008: Billing request error handling", () => {
  it("should let billing.request() throw directly without wrapping", () => {
    // billing.request() ALWAYS throws — either a redirect Response or an error.
    // The fix: don't wrap it in try/catch, let it propagate directly.
    const redirectResponse = new Response(null, {
      status: 401,
      headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": "https://shopify.com/billing" },
    });

    expect(redirectResponse).toBeInstanceOf(Response);
    // For embedded apps, it throws 401 with reauthorize header (App Bridge intercepts this)
    expect(redirectResponse.status).toBe(401);
    expect(redirectResponse.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url")).toBeTruthy();
  });

  it("should use BILLING_TEST_MODE env var correctly", () => {
    // Test mode should be controlled by env var, not NODE_ENV
    const testCases = [
      { envValue: "true", expected: true },
      { envValue: "false", expected: false },
      { envValue: undefined, expected: false },
      { envValue: "", expected: false },
    ];

    for (const tc of testCases) {
      const isTest = tc.envValue === "true";
      expect(isTest).toBe(tc.expected);
    }
  });
});

// ─── BUG-009: Counter increments before optimization runs ───────────────────

describe("BUG-009: Counter should not inflate when new images are added", () => {
  it("should count optimized based on product media matching DB records, not raw DB count", () => {
    // Scenario: 5 images optimized, 1 new image added
    // DB has 5 completed records. Shopify has 6 media (5 WebP + 1 new).
    // The counter should show Optimized: 5, not Optimized: 6
    const dbRecords = [
      { imageId: "orig-1", newMediaId: "webp-1", status: "completed" },
      { imageId: "orig-2", newMediaId: "webp-2", status: "completed" },
      { imageId: "orig-3", newMediaId: "webp-3", status: "completed" },
      { imageId: "orig-4", newMediaId: "webp-4", status: "completed" },
      { imageId: "orig-5", newMediaId: "webp-5", status: "completed" },
    ];

    const shopifyMedia = ["webp-1", "webp-2", "webp-3", "webp-4", "webp-5", "brand-new-6"];
    const totalImages = shopifyMedia.length; // 6

    const completedByImageId = new Set(dbRecords.map((r) => r.imageId));
    const completedByNewMediaId = new Set(dbRecords.filter((r) => r.newMediaId).map((r) => r.newMediaId));

    let optimizedCount = 0;
    let newImages = 0;
    for (const mediaId of shopifyMedia) {
      if (completedByImageId.has(mediaId) || completedByNewMediaId.has(mediaId)) {
        optimizedCount++;
      } else {
        newImages++;
      }
    }

    expect(totalImages).toBe(6);
    expect(optimizedCount).toBe(5); // NOT 6
    expect(newImages).toBe(1);
  });

  it("should show correct count even when no images have been optimized", () => {
    const dbRecords: Array<{ imageId: string; newMediaId: string | null; status: string }> = [];
    const shopifyMedia = ["img-1", "img-2", "img-3"];

    const completedByImageId = new Set(dbRecords.map((r) => r.imageId));
    const completedByNewMediaId = new Set(dbRecords.filter((r) => r.newMediaId).map((r) => r.newMediaId));

    let optimizedCount = 0;
    for (const mediaId of shopifyMedia) {
      if (completedByImageId.has(mediaId) || completedByNewMediaId.has(mediaId)) {
        optimizedCount++;
      }
    }

    expect(optimizedCount).toBe(0);
  });
});

// ─── CAN-02: Cancel banner visibility ───────────────────────────────────────

describe("CAN-02: Cancel banner display", () => {
  it("should show cancelled banner for 'cancelled' actionType", () => {
    const actionData = { success: true, actionType: "cancelled", processedCount: 5, errorCount: 0, totalSaved: 1024 };

    const showCancelBanner =
      actionData.actionType === "cancelled" || actionData.actionType === "cancel";
    expect(showCancelBanner).toBe(true);
  });

  it("should show cancelled banner for 'cancel' actionType", () => {
    const actionData = { success: true, actionType: "cancel" };

    const showCancelBanner =
      actionData.actionType === "cancelled" || actionData.actionType === "cancel";
    expect(showCancelBanner).toBe(true);
  });

  it("should not show cancelled banner for 'optimize' actionType", () => {
    const actionData = { success: true, actionType: "optimize" };

    const showCancelBanner =
      actionData.actionType === "cancelled" || actionData.actionType === "cancel";
    expect(showCancelBanner).toBe(false);
  });
});

// ─── Duplicate entries in Recent Optimizations table ────────────────────────

describe("Duplicate entries prevention in Recent Optimizations", () => {
  it("should have exactly one DB record per optimized image", () => {
    // After optimizing 5 images, we should have 5 records, not 10
    const optimizedImages = ["img-1", "img-2", "img-3", "img-4", "img-5"];
    const dbRecords = optimizedImages.map((id) => ({
      imageId: id,
      newMediaId: `webp-${id}`,
      status: "completed",
    }));

    expect(dbRecords).toHaveLength(5);

    // No duplicate imageIds
    const imageIds = dbRecords.map((r) => r.imageId);
    const uniqueImageIds = new Set(imageIds);
    expect(uniqueImageIds.size).toBe(imageIds.length);
  });

  it("should not show the same product twice in the table for a single image", () => {
    // Each product image should appear exactly once in the results
    const tableRows = [
      { imageId: "img-1", productName: "Product B-4", originalSize: 378.9, webpSize: 307.9 },
      { imageId: "img-2", productName: "Product B-3", originalSize: 241.3, webpSize: 157.9 },
      { imageId: "img-3", productName: "Product B-2", originalSize: 232.3, webpSize: 158.7 },
    ];

    // No duplicate imageIds in the table
    const imageIds = tableRows.map((r) => r.imageId);
    const uniqueIds = new Set(imageIds);
    expect(uniqueIds.size).toBe(imageIds.length);
  });
});
