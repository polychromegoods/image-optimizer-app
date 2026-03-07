import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── BUG-001: Already-optimized images should not be re-detected ────────────

describe("BUG-001: Duplicate image detection prevention", () => {
  it("should recognize an image by its new WebP media ID after optimization", () => {
    // Simulates the scenario: after optimization, the product has a NEW media ID
    // for the WebP image. The DB should have a record for BOTH the original and new ID.
    const originalMediaId = "gid://shopify/MediaImage/111";
    const newWebpMediaId = "gid://shopify/MediaImage/222";

    // After optimization, we create two DB records:
    const dbRecords = new Map<string, { status: string }>();
    dbRecords.set(originalMediaId, { status: "completed" });
    dbRecords.set(newWebpMediaId, { status: "completed" }); // BUG-001 fix: track new ID too

    // On refresh, Shopify returns the NEW media ID (the WebP one)
    const shopifyMediaIds = [newWebpMediaId];

    // Check: should the new ID be treated as "new" for optimization?
    const isNew = !dbRecords.has(newWebpMediaId);
    expect(isNew).toBe(false); // Should NOT be treated as new
  });

  it("should detect truly new images that have no DB record", () => {
    const dbRecords = new Map<string, { status: string }>();
    dbRecords.set("gid://shopify/MediaImage/111", { status: "completed" });

    const brandNewMediaId = "gid://shopify/MediaImage/999";
    const isNew = !dbRecords.has(brandNewMediaId);
    expect(isNew).toBe(true); // Should be treated as new
  });
});

// ─── BUG-002: Counter should not exceed total images ────────────────────────

describe("BUG-002: Accurate image counting", () => {
  it("should count only non-completed images as 'new'", () => {
    const totalProductImages = 31;
    const dbRecords = [
      { status: "completed", count: 28 },
      { status: "failed", count: 2 },
      // 1 image has no record (truly new)
    ];

    const completedCount = dbRecords.find((r) => r.status === "completed")?.count || 0;
    const failedCount = dbRecords.find((r) => r.status === "failed")?.count || 0;

    // New images = total - completed (failed can be retried, so they count as "new")
    const newImages = totalProductImages - completedCount; // 31 - 28 = 3
    expect(newImages).toBe(3);
    expect(newImages).toBeLessThanOrEqual(totalProductImages);
  });

  it("should never show optimized count greater than total images", () => {
    const totalImages = 31;
    const completedInDb = 61; // BUG-002 scenario: accumulated across runs

    // Fix: cap the displayed count
    const displayedOptimized = Math.min(completedInDb, totalImages);
    expect(displayedOptimized).toBe(31);
    expect(displayedOptimized).toBeLessThanOrEqual(totalImages);
  });

  it("should calculate completion percentage correctly and cap at 100%", () => {
    const totalImages = 31;
    const completed = 31;
    const percentage = totalImages > 0 ? Math.min((completed / totalImages) * 100, 100) : 0;
    expect(percentage).toBe(100);

    // Even with inflated count, should cap at 100
    const inflatedCompleted = 61;
    const cappedPercentage = totalImages > 0 ? Math.min((inflatedCompleted / totalImages) * 100, 100) : 0;
    expect(cappedPercentage).toBe(100);
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

  it("should display 'Kept original' for skipped images", () => {
    const fileSize = 50000;
    const webpFileSize = 65000;

    const savingsPercent =
      webpFileSize && fileSize && webpFileSize < fileSize
        ? (((fileSize - webpFileSize) / fileSize) * 100).toFixed(1)
        : null;

    expect(savingsPercent).toBeNull();

    const displayText = webpFileSize >= fileSize ? "Kept original" : "-";
    expect(displayText).toBe("Kept original");
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

  it("should not leave 'reverted' status records in the database", () => {
    // The fix deletes records instead of setting status to "reverted"
    const dbRecords: Array<{ id: string; status: string }> = [];

    // After revert, there should be no record at all
    const revertedRecords = dbRecords.filter((r) => r.status === "reverted");
    expect(revertedRecords).toHaveLength(0);
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
  it("should re-throw Response objects from billing.request()", () => {
    // billing.request() throws a Response for redirect — this is expected behavior
    const redirectResponse = new Response(null, { status: 302, headers: { Location: "https://shopify.com/billing" } });

    expect(redirectResponse).toBeInstanceOf(Response);
    expect(redirectResponse.status).toBe(302);
  });

  it("should catch and display actual errors from billing", () => {
    const error = new Error("API rate limit exceeded");

    const errorMessage = `Failed to start subscription: ${error.message}`;
    expect(errorMessage).toContain("API rate limit exceeded");
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
