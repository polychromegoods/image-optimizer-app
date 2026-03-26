import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, defer } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
  useRouteError,
  isRouteErrorResponse,
  Await,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  Text,
  Banner,
  ProgressBar,
  Badge,
  InlineStack,
  Modal,
  Thumbnail,
  Spinner,
  SkeletonBodyText,
  SkeletonDisplayText,
} from "@shopify/polaris";
import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

import type { LoaderData, StatsMap, ActionResult } from "../lib/types";
import {
  QUERY_SHOP_NAME,
  RECENT_OPTIMIZATIONS_LIMIT,
  POLLING_INTERVAL_MS,
} from "../lib/constants";
import { extractIdFromGid } from "../lib/templates";
import { fetchAllProducts, getProductImages } from "../lib/shopify-media";
import {
  runOptimizationLoop,
  revertSingleOptimization,
  countImagesToProcess,
  getRunningJob,
} from "../lib/optimization-engine";

// ─── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fast DB queries — return immediately with the page shell
  const [stats, recentOptimizations, seoSettings, activeJob] =
    await Promise.all([
      db.imageOptimization.groupBy({
        by: ["status"],
        where: { shop },
        _count: { status: true },
      }),
      db.imageOptimization.findMany({
        where: { shop },
        orderBy: { updatedAt: "desc" },
        take: RECENT_OPTIMIZATIONS_LIMIT,
      }),
      db.seoSettings.findUnique({ where: { shop } }),
      db.optimizationJob.findFirst({
        where: { shop, status: "running" },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  // Slow product fetch — defer so the page renders immediately
  const productDataPromise = fetchAllProducts(admin).then(async (products) => {
    console.log(`[Loader] Shop: ${shop}, Products fetched: ${products.length}`);
    const counts = await countImagesToProcess(shop, products, null);
    return {
      products,
      totalImages: counts.totalImages,
      newImages: counts.newImages,
      optimizedCount: counts.optimizedCount,
    };
  });

  return defer({
    shop,
    stats,
    recentOptimizations: recentOptimizations as LoaderData["recentOptimizations"],
    seoSettings,
    activeJob,
    productData: productDataPromise,
  });
};

// ─── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("action") as string;

  // ── Refresh ──
  if (actionType === "refresh") {
    return json<ActionResult>({ success: true, message: "Refreshed" });
  }

  // ── Cancel ──
  if (actionType === "cancel") {
    const jobId = formData.get("jobId") as string | null;
    const targetJob = jobId
      ? await db.optimizationJob.findUnique({ where: { id: jobId } })
      : await db.optimizationJob.findFirst({
          where: { shop, status: "running" },
          orderBy: { createdAt: "desc" },
        });

    if (targetJob) {
      await db.optimizationJob.update({
        where: { id: targetJob.id },
        data: { cancelled: true, status: "cancelled" },
      });
    }
    return json<ActionResult>({ success: true, actionType: "cancel" });
  }

  // ── Optimize New / Retry Single ──
  if (actionType === "optimize_new" || actionType === "retry_single") {
    const isRetry = actionType === "retry_single";
    const targetImageId = isRetry ? (formData.get("imageId") as string) : null;

    // BUG-007 FIX: Check for already running job
    const existingJob = await getRunningJob(shop);
    if (existingJob && !isRetry) {
      return json<ActionResult>({
        success: false,
        message: "An optimization is already running. Please wait for it to finish or cancel it first.",
      });
    }

    const [seoSettings, shopResponse] = await Promise.all([
      db.seoSettings.findUnique({ where: { shop } }),
      admin.graphql(QUERY_SHOP_NAME),
    ]);

    const shopData = await shopResponse.json();
    const shopName = (shopData as { data?: { shop?: { name?: string } } }).data?.shop?.name || shop;

    // Fetch ALL products with pagination
    const products = await fetchAllProducts(admin);

    // Count images to process
    const { imagesToProcess } = await countImagesToProcess(shop, products, targetImageId);

    // Create job record
    const job = await db.optimizationJob.create({
      data: { shop, status: "running", totalImages: imagesToProcess },
    });

    // Run the optimization loop
    const result = await runOptimizationLoop({
      admin,
      shop,
      products,
      shopName,
      seoSettings,
      jobId: job.id,
      targetImageId,
      isRetry,
    });

    if (result.cancelled) {
      return json<ActionResult>({
        success: true,
        actionType: "cancelled",
        processedCount: result.processedCount,
        errorCount: result.errorCount,
        skippedCount: result.skippedCount,
        totalSaved: result.totalSaved,
        jobId: job.id,
      });
    }

    // Mark job as completed
    await db.optimizationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        processedCount: result.processedCount,
        errorCount: result.errorCount,
        skippedCount: result.skippedCount,
        totalSaved: result.totalSaved,
        currentImage: null,
      },
    });

    return json<ActionResult>({
      success: true,
      actionType: isRetry ? "retry" : "optimize",
      processedCount: result.processedCount,
      errorCount: result.errorCount,
      skippedCount: result.skippedCount,
      totalSaved: result.totalSaved,
      jobId: job.id,
    });
  }

  // ── Revert All ──
  if (actionType === "revert_all") {
    const optimizations = await db.imageOptimization.findMany({
      where: { shop, status: "completed" },
    });

    let revertedCount = 0;
    let errorCount = 0;

    for (const opt of optimizations) {
      try {
        await revertSingleOptimization(admin, {
          ...opt,
          shop,
        });
        revertedCount++;
      } catch (error) {
        console.error(`Error reverting image ${opt.imageId}:`, error);
        errorCount++;
      }
      // BUG-005 FIX: Small delay between reverts to reduce connection pressure
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return json<ActionResult>({
      success: true,
      actionType: "revert",
      revertedCount,
      errorCount,
    });
  }

  // ── Revert Single ──
  if (actionType === "revert_single") {
    const optimizationId = formData.get("optimizationId") as string;

    try {
      const opt = await db.imageOptimization.findUnique({
        where: { id: optimizationId },
      });

      if (!opt || opt.status !== "completed") {
        return json<ActionResult>({
          success: false,
          message: "Optimization not found or not completed",
        });
      }

      await revertSingleOptimization(admin, {
        ...opt,
        shop,
      });
      return json<ActionResult>({ success: true, actionType: "revert_single" });
    } catch (error) {
      console.error("Error reverting single image:", error);
      return json<ActionResult>({ success: false, message: "Failed to revert image" });
    }
  }

  return json<ActionResult>({ success: false });
};

// ─── Component ─────────────────────────────────────────────────────────────────

export default function ImageOptimizer() {
  const {
    stats: initialStats,
    recentOptimizations: initialOptimizations,
    seoSettings,
    activeJob: initialActiveJob,
    productData,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const submit = useSubmit();
  const navigation = useNavigation();

  const [showRevertModal, setShowRevertModal] = useState(false);
  const [compareImage, setCompareImage] = useState<Record<string, unknown> | null>(null);

  // Live progress state
  const [liveJob, setLiveJob] = useState<Record<string, unknown> | null>(
    initialActiveJob as Record<string, unknown> | null,
  );
  const [liveStats, setLiveStats] = useState(initialStats);
  const [liveOptimizations, setLiveOptimizations] = useState(initialOptimizations);
  // BUG-006 FIX: Track network errors for user-friendly display
  const [networkError, setNetworkError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const networkErrorCountRef = useRef(0);

  const isSubmitting = navigation.state === "submitting";
  const submittingAction = navigation.formData?.get("action");

  const isOptimizing =
    (isSubmitting && submittingAction === "optimize_new") ||
    (liveJob as Record<string, unknown> | null)?.status === "running";
  const isRefreshing = isSubmitting && submittingAction === "refresh";
  const isRevertingAll = isSubmitting && submittingAction === "revert_all";
  const revertingId = isSubmitting && submittingAction === "revert_single"
    ? (navigation.formData?.get("optimizationId") as string | null)
    : null;
  const retryingImageId = isSubmitting && submittingAction === "retry_single"
    ? (navigation.formData?.get("imageId") as string | null)
    : null;
  const isCancelling = isSubmitting && submittingAction === "cancel";

  // ── Polling for live updates during optimization ──
  useEffect(() => {
    const shouldPoll = (liveJob as Record<string, unknown> | null)?.status === "running" || isOptimizing;

    if (shouldPoll && !pollingRef.current) {
      networkErrorCountRef.current = 0;
      pollingRef.current = setInterval(async () => {
        try {
          const resp = await fetch("/api/optimization-status", {
            credentials: "same-origin",
          });
          if (resp.ok) {
            const data = await resp.json();
            networkErrorCountRef.current = 0;
            setNetworkError(null);

            if (data.hasJob) {
              setLiveJob(data.job);
              setLiveStats(data.stats);
              setLiveOptimizations(data.recentOptimizations);

              if (data.job.status !== "running") {
                if (pollingRef.current) {
                  clearInterval(pollingRef.current);
                  pollingRef.current = null;
                }
              }
            }
          }
        } catch (err) {
          networkErrorCountRef.current++;
          if (networkErrorCountRef.current >= 3) {
            setNetworkError(
              "Having trouble connecting to the server. The optimization may still be running. Please wait or refresh the page.",
            );
          }
        }
      }, POLLING_INTERVAL_MS);
    }

    if (!shouldPoll && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [liveJob, isOptimizing]);

  // Sync loader data when it changes (e.g., after form submission)
  useEffect(() => {
    setLiveStats(initialStats);
    setLiveOptimizations(initialOptimizations);
    if (initialActiveJob) {
      setLiveJob(initialActiveJob as Record<string, unknown>);
    }
  }, [initialStats, initialOptimizations, initialActiveJob]);

  // Trigger polling when optimization form is submitted
  useEffect(() => {
    if (isSubmitting && submittingAction === "optimize_new" && !pollingRef.current) {
      const timeout = setTimeout(() => setLiveJob({ status: "running" }), 500);
      return () => clearTimeout(timeout);
    }
  }, [isSubmitting, submittingAction]);

  // Derived state
  const stats = liveStats || initialStats;
  const recentOptimizations = liveOptimizations || initialOptimizations;

  const statsMap: StatsMap = (Array.isArray(stats) ? stats : []).reduce(
    (acc: StatsMap, stat: { status: string; _count: { status: number } }) => {
      acc[stat.status] = stat._count.status;
      return acc;
    },
    { pending: 0, processing: 0, completed: 0, failed: 0, reverted: 0 },
  );

  const job = liveJob as Record<string, number | string | null> | null;
  const jobProgress =
    job && (job.totalImages as number) > 0
      ? (((job.processedCount as number) + (job.errorCount as number) + (job.skippedCount as number)) /
          (job.totalImages as number)) *
        100
      : 0;

  // ── Handlers ──

  const handleOptimizeNew = () => {
    setNetworkError(null);
    const fd = new FormData();
    fd.append("action", "optimize_new");
    submit(fd, { method: "post" });
  };

  const handleRefresh = () => {
    const fd = new FormData();
    fd.append("action", "refresh");
    submit(fd, { method: "post", replace: true });
  };

  const handleRevertAll = useCallback(() => {
    const fd = new FormData();
    fd.append("action", "revert_all");
    submit(fd, { method: "post" });
    setShowRevertModal(false);
  }, [submit]);

  const handleRevertSingle = (optimizationId: string) => {
    const fd = new FormData();
    fd.append("action", "revert_single");
    fd.append("optimizationId", optimizationId);
    submit(fd, { method: "post" });
  };

  const handleRetrySingle = (imageId: string) => {
    const fd = new FormData();
    fd.append("action", "retry_single");
    fd.append("imageId", imageId);
    submit(fd, { method: "post" });
  };

  const handleCancel = () => {
    const fd = new FormData();
    fd.append("action", "cancel");
    if (job?.id) fd.append("jobId", job.id as string);
    submit(fd, { method: "post" });
  };

  // ── Render ──

  return (
    <Page
      title="Image Optimizer"
      subtitle="Compress product images to WebP for faster loading. Original images are backed up and can be restored anytime."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* BUG-006 FIX: Network error banner */}
            {networkError && (
              <Banner tone="warning" title="Connection Issue" onDismiss={() => setNetworkError(null)}>
                <p>{networkError}</p>
              </Banner>
            )}

            {/* BUG-007 FIX: Show error if concurrent optimization attempted */}
            {actionData && !actionData.success && "message" in actionData && actionData.message && (
              <Banner tone="critical" title="Error">
                <p>{actionData.message}</p>
              </Banner>
            )}

            {/* Result banners */}
            <ResultBanners actionData={actionData} isOptimizing={isOptimizing} statsMap={statsMap} />

            {seoSettings?.autoApplyOnOptimize && (
              <Banner tone="info">
                <p>
                  SEO alt text and filenames will be applied automatically during optimization.
                  <a href="/app/settings"> Edit templates</a>
                </p>
              </Banner>
            )}

            {/* Live progress card */}
            {isOptimizing && job && (
              <LiveProgressCard
                job={job}
                jobProgress={jobProgress}
                onCancel={handleCancel}
                isCancelling={isCancelling}
              />
            )}

            {/* Sync card */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Sync Images</Text>
                <Text as="p" tone="subdued">
                  If you uploaded new product images, click refresh to detect them.
                </Text>
                <div>
                  <Button onClick={handleRefresh} loading={isRefreshing} disabled={isOptimizing}>
                    Refresh
                  </Button>
                </div>
              </BlockStack>
            </Card>

            {/* Deferred product data — shows skeleton while loading */}
            <Suspense fallback={<ProductDataSkeleton />}>
              <Await
                resolve={productData}
                errorElement={
                  <Banner tone="critical" title="Failed to load product data">
                    <p>Could not fetch products from Shopify. Please try refreshing the page.</p>
                  </Banner>
                }
              >
                {(resolved) => {
                  const { products, totalImages, newImages, optimizedCount } = resolved as {
                    products: Array<{ id: string; title: string }>;
                    totalImages: number;
                    newImages: number;
                    optimizedCount: number;
                  };

                  const completionPercentage = totalImages > 0 ? Math.min((optimizedCount / totalImages) * 100, 100) : 0;

                  // Product name lookup
                  const productMap: Record<string, string> = {};
                  for (const p of products) {
                    productMap[p.id] = p.title;
                  }

                  return (
                    <>
                      {newImages > 0 && !isOptimizing && (
                        <Banner tone="info">
                          <p>
                            Found {newImages} new image{newImages !== 1 ? "s" : ""} ready to optimize.
                          </p>
                        </Banner>
                      )}

                      {/* Optimization progress card (hidden during active optimization) */}
                      {!isOptimizing && (
                        <Card>
                          <BlockStack gap="400">
                            <Text as="h2" variant="headingMd">Optimization Progress</Text>
                            <ProgressBar progress={completionPercentage} size="small" />
                            <BlockStack gap="200">
                              <Text as="p">Total images: {totalImages}</Text>
                              <Text as="p">
                                Optimized: {optimizedCount} | Failed: {statsMap.failed}
                              </Text>
                            </BlockStack>
                            <InlineStack gap="300">
                              <Button
                                variant="primary"
                                onClick={handleOptimizeNew}
                                size="large"
                                disabled={newImages === 0}
                              >
                                {newImages > 0
                                  ? `Optimize ${newImages} New Image${newImages !== 1 ? "s" : ""}`
                                  : "No New Images to Optimize"}
                              </Button>
                              {optimizedCount > 0 && (
                                <Button
                                  tone="critical"
                                  onClick={() => setShowRevertModal(true)}
                                  loading={isRevertingAll}
                                >
                                  Revert All to Originals
                                </Button>
                              )}
                            </InlineStack>
                          </BlockStack>
                        </Card>
                      )}

                      {/* Recent optimizations table */}
                      <OptimizationsTable
                        optimizations={recentOptimizations}
                        productMap={productMap}
                        revertingId={revertingId}
                        retryingImageId={retryingImageId}
                        isRevertingAll={isRevertingAll}
                        onCompare={setCompareImage}
                        onRevert={handleRevertSingle}
                        onRetry={handleRetrySingle}
                      />
                    </>
                  );
                }}
              </Await>
            </Suspense>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Revert confirmation modal */}
      {showRevertModal && (
        <Modal
          open={showRevertModal}
          onClose={() => setShowRevertModal(false)}
          title="Revert All Images?"
          primaryAction={{ content: "Revert All", destructive: true, onAction: handleRevertAll }}
          secondaryActions={[{ content: "Cancel", onAction: () => setShowRevertModal(false) }]}
        >
          <Modal.Section>
            <Text as="p">
              This will restore all {statsMap.completed} optimized images back to their originals
              using the backed-up copies. Your WebP versions will be removed from the products.
            </Text>
          </Modal.Section>
        </Modal>
      )}

      {/* Compare modal */}
      {compareImage && (
        <CompareModal image={compareImage} onClose={() => setCompareImage(null)} />
      )}
    </Page>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function ProductDataSkeleton() {
  return (
    <BlockStack gap="500">
      <Card>
        <BlockStack gap="400">
          <SkeletonDisplayText size="small" />
          <SkeletonBodyText lines={1} />
          <div style={{ height: "8px", background: "#e4e5e7", borderRadius: "4px" }} />
          <SkeletonBodyText lines={2} />
          <div style={{ display: "flex", gap: "12px" }}>
            <div
              style={{
                width: "200px",
                height: "36px",
                background: "#e4e5e7",
                borderRadius: "8px",
              }}
            />
          </div>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="400">
          <SkeletonDisplayText size="small" />
          <SkeletonBodyText lines={4} />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ResultBanners({
  actionData,
  isOptimizing,
  statsMap,
}: {
  actionData: ActionResult | undefined;
  isOptimizing: boolean;
  statsMap: StatsMap;
}) {
  if (!actionData || !("actionType" in actionData)) return null;
  // Don't show error messages here — they're handled separately above
  if (!actionData.success && "message" in actionData) return null;

  return (
    <>
      {actionData.actionType === "optimize" && !isOptimizing && (
        <Banner
          tone={(actionData as { errorCount?: number }).errorCount ? "warning" : "success"}
          title="Optimization Complete"
        >
          <p>
            Processed: {(actionData as { processedCount: number }).processedCount} | Skipped:{" "}
            {(actionData as { skippedCount: number }).skippedCount} | Errors:{" "}
            {(actionData as { errorCount: number }).errorCount}
            {(actionData as { totalSaved: number }).totalSaved > 0 &&
              ` | Total saved: ${((actionData as { totalSaved: number }).totalSaved / 1024).toFixed(1)} KB`}
          </p>
        </Banner>
      )}

      {/* CAN-02 FIX: Show cancelled banner from both actionData AND from cancel action */}
      {(actionData.actionType === "cancelled" || actionData.actionType === "cancel") && (
        <Banner tone="warning" title="Optimization Cancelled">
          <p>
            {"processedCount" in actionData
              ? `Stopped after processing ${(actionData as { processedCount: number }).processedCount} image${(actionData as { processedCount: number }).processedCount !== 1 ? "s" : ""}.`
              : "Optimization was cancelled."}
            {"errorCount" in actionData && (actionData as { errorCount: number }).errorCount > 0 &&
              ` ${(actionData as { errorCount: number }).errorCount} error(s).`}
            {"totalSaved" in actionData && (actionData as { totalSaved: number }).totalSaved > 0 &&
              ` Saved ${((actionData as { totalSaved: number }).totalSaved / 1024).toFixed(1)} KB so far.`}
          </p>
        </Banner>
      )}

      {actionData.actionType === "retry" && (
        <Banner
          tone={(actionData as { errorCount?: number }).errorCount ? "warning" : "success"}
          title="Retry Complete"
        >
          <p>
            Processed: {(actionData as { processedCount: number }).processedCount} | Errors:{" "}
            {(actionData as { errorCount: number }).errorCount}
          </p>
        </Banner>
      )}

      {actionData.actionType === "revert" && (
        <Banner
          tone={
            (actionData as { errorCount: number }).errorCount > 0
              ? (actionData as { revertedCount: number }).revertedCount > 0
                ? "warning"
                : "critical"
              : "success"
          }
          title="Revert Complete"
        >
          <p>
            Reverted {(actionData as { revertedCount: number }).revertedCount} image
            {(actionData as { revertedCount: number }).revertedCount !== 1 ? "s" : ""} back to originals.
            {(actionData as { errorCount: number }).errorCount > 0 &&
              ` ${(actionData as { errorCount: number }).errorCount} error(s) occurred.`}
          </p>
        </Banner>
      )}

      {actionData.actionType === "revert_single" && (
        <Banner tone="success" title="Image Reverted">
          <p>The image has been restored to its original version.</p>
        </Banner>
      )}
    </>
  );
}

function LiveProgressCard({
  job,
  jobProgress,
  onCancel,
  isCancelling,
}: {
  job: Record<string, number | string | null>;
  jobProgress: number;
  onCancel: () => void;
  isCancelling: boolean;
}) {
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" />
            <Text as="h2" variant="headingMd">Optimizing Images...</Text>
          </InlineStack>
          <Button tone="critical" onClick={onCancel} loading={isCancelling}>
            Cancel
          </Button>
        </InlineStack>

        <ProgressBar progress={Math.min(jobProgress, 100)} size="small" tone="primary" />

        <BlockStack gap="100">
          <Text as="p" variant="bodySm">
            {(job.processedCount as number) || 0} of {(job.totalImages as number) || "?"} images processed
            {((job.errorCount as number) || 0) > 0 && ` | ${job.errorCount} error(s)`}
            {((job.skippedCount as number) || 0) > 0 && ` | ${job.skippedCount} skipped`}
          </Text>
          {job.currentImage && (
            <Text as="p" variant="bodySm" tone="subdued">
              Currently processing: {job.currentImage as string}
            </Text>
          )}
          {((job.totalSaved as number) || 0) > 0 && (
            <Text as="p" variant="bodySm" tone="success">
              Saved so far: {(((job.totalSaved as number) || 0) / 1024).toFixed(1)} KB
            </Text>
          )}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function OptimizationsTable({
  optimizations,
  productMap,
  revertingId,
  retryingImageId,
  isRevertingAll,
  onCompare,
  onRevert,
  onRetry,
}: {
  optimizations: Array<Record<string, unknown>>;
  productMap: Record<string, string>;
  revertingId: string | null;
  retryingImageId: string | null;
  isRevertingAll: boolean;
  onCompare: (opt: Record<string, unknown>) => void;
  onRevert: (id: string) => void;
  onRetry: (imageId: string) => void;
}) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Recent Optimizations</Text>
        {optimizations.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e1e3e5", textAlign: "left" }}>
                  <th style={{ padding: "12px 8px" }}>Preview</th>
                  <th style={{ padding: "12px 8px" }}>Product</th>
                  <th style={{ padding: "12px 8px" }}>Status</th>
                  <th style={{ padding: "12px 8px" }}>Original</th>
                  <th style={{ padding: "12px 8px" }}>WebP</th>
                  <th style={{ padding: "12px 8px" }}>Savings</th>
                  <th style={{ padding: "12px 8px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {optimizations.map((opt) => (
                  <OptimizationRow
                    key={opt.id as string}
                    opt={opt}
                    productName={
                      productMap[opt.productId as string] ||
                      extractIdFromGid(opt.productId as string)
                    }
                    isRowReverting={revertingId === (opt.id as string) || isRevertingAll}
                    isRowRetrying={retryingImageId === (opt.imageId as string)}
                    onCompare={onCompare}
                    onRevert={onRevert}
                    onRetry={onRetry}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Text as="p" tone="subdued">
            No optimizations yet. Click Refresh, then Optimize to start.
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

function OptimizationRow({
  opt,
  productName,
  isRowReverting,
  isRowRetrying,
  onCompare,
  onRevert,
  onRetry,
}: {
  opt: Record<string, unknown>;
  productName: string;
  isRowReverting: boolean;
  isRowRetrying: boolean;
  onCompare: (opt: Record<string, unknown>) => void;
  onRevert: (id: string) => void;
  onRetry: (imageId: string) => void;
}) {
  const thumbUrl = (opt.webpUrl || opt.originalUrl) as string | null;
  const status = opt.status as string;
  const fileSize = opt.fileSize as number | null;
  const webpFileSize = opt.webpFileSize as number | null;

  const statusTone =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "critical"
        : status === "processing"
          ? "attention"
          : status === "reverted"
            ? "warning"
            : "info";

  // BUG-003: Show savings correctly — if webp >= original, show 0%
  const savingsPercent =
    webpFileSize && fileSize && webpFileSize < fileSize
      ? (((fileSize - webpFileSize) / fileSize) * 100).toFixed(1)
      : null;

  return (
    <tr style={{ borderBottom: "1px solid #f1f2f3" }}>
      <td style={{ padding: "8px" }}>
        {thumbUrl ? (
          <div
            onClick={() => status === "completed" && onCompare(opt)}
            style={{ cursor: status === "completed" ? "pointer" : "default" }}
            title={status === "completed" ? "Click to compare original vs WebP" : ""}
          >
            <Thumbnail
              source={thumbUrl}
              alt={`Image ${extractIdFromGid(opt.imageId as string)}`}
              size="small"
            />
          </div>
        ) : (
          <div
            style={{
              width: 40,
              height: 40,
              backgroundColor: "#f1f2f3",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "10px",
              color: "#8c9196",
            }}
          >
            N/A
          </div>
        )}
      </td>
      <td style={{ padding: "8px" }}>
        <Text as="span" variant="bodyMd" fontWeight="semibold">{productName}</Text>
      </td>
      <td style={{ padding: "8px" }}>
        <Badge tone={statusTone}>{status}</Badge>
      </td>
      <td style={{ padding: "8px" }}>
        {fileSize ? `${(fileSize / 1024).toFixed(1)} KB` : "-"}
      </td>
      <td style={{ padding: "8px" }}>
        {webpFileSize ? `${(webpFileSize / 1024).toFixed(1)} KB` : "-"}
      </td>
      <td style={{ padding: "8px" }}>
        {savingsPercent ? (
          <span style={{ color: "#008060", fontWeight: 600 }}>
            {savingsPercent}%
          </span>
        ) : fileSize && webpFileSize && webpFileSize >= fileSize ? (
          <span style={{ color: "#8c9196" }}>
            Kept original
          </span>
        ) : (
          "-"
        )}
      </td>
      <td style={{ padding: "8px" }}>
        <InlineStack gap="200">
          {status === "completed" && (
            <>
              <Button size="slim" onClick={() => onCompare(opt)}>Compare</Button>
              <Button
                size="slim"
                tone="critical"
                onClick={() => onRevert(opt.id as string)}
                loading={isRowReverting}
              >
                Revert
              </Button>
            </>
          )}
          {status === "failed" && (
            <Button
              size="slim"
              variant="primary"
              onClick={() => onRetry(opt.imageId as string)}
              loading={isRowRetrying}
            >
              Retry
            </Button>
          )}
        </InlineStack>
      </td>
    </tr>
  );
}

// ─── Error Boundary ──────────────────────────────────────────────────────────
// ERR-03/BUG-006 FIX: Route-level error boundary catches unhandled errors
// (e.g., network failures during form submission) and shows a friendly message
// instead of crashing the entire app with "Application Error".

export function ErrorBoundary() {
  const error = useRouteError();
  const isNetworkError =
    error instanceof Error &&
    (error.message.includes("Failed to fetch") ||
     error.message.includes("NetworkError") ||
     error.message.includes("Load failed"));

  const title = isNetworkError ? "Connection Lost" : "Something went wrong";
  const message = isNetworkError
    ? "Your network connection was interrupted. The optimization may still be running in the background. Please check your connection and refresh the page."
    : isRouteErrorResponse(error)
      ? `${error.status}: ${error.statusText}`
      : error instanceof Error
        ? error.message
        : "An unexpected error occurred. Please refresh the page and try again.";

  return (
    <Page title="Image Optimizer">
      <Layout>
        <Layout.Section>
          <Banner tone="critical" title={title}>
            <p>{message}</p>
          </Banner>
          <div style={{ marginTop: "16px" }}>
            <Button url="/app/image-optimizer" variant="primary">
              Refresh Page
            </Button>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function CompareModal({
  image,
  onClose,
}: {
  image: Record<string, unknown>;
  onClose: () => void;
}) {
  const fileSize = image.fileSize as number | null;
  const webpFileSize = image.webpFileSize as number | null;
  const originalSrc = (image.backupUrl || image.originalUrl) as string;
  const webpSrc = image.webpUrl as string;

  return (
    <Modal
      open
      onClose={onClose}
      title="Compare: Original vs WebP"
      large
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <Modal.Section>
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "250px" }}>
            <BlockStack gap="300">
              <InlineStack align="center" gap="200">
                <Badge tone="warning">Original</Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  {fileSize ? `${(fileSize / 1024).toFixed(1)} KB` : ""}
                </Text>
              </InlineStack>
              <div
                style={{
                  border: "1px solid #e1e3e5",
                  borderRadius: "8px",
                  overflow: "hidden",
                  backgroundColor: "#fafafa",
                }}
              >
                <img src={originalSrc} alt="Original" style={{ width: "100%", height: "auto", display: "block" }} />
              </div>
            </BlockStack>
          </div>
          <div style={{ flex: 1, minWidth: "250px" }}>
            <BlockStack gap="300">
              <InlineStack align="center" gap="200">
                <Badge tone="success">WebP (Optimized)</Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  {webpFileSize ? `${(webpFileSize / 1024).toFixed(1)} KB` : ""}
                </Text>
                {fileSize && webpFileSize && webpFileSize < fileSize && (
                  <Text as="span" variant="bodySm" tone="success">
                    {(((fileSize - webpFileSize) / fileSize) * 100).toFixed(1)}% smaller
                  </Text>
                )}
              </InlineStack>
              <div
                style={{
                  border: "1px solid #e1e3e5",
                  borderRadius: "8px",
                  overflow: "hidden",
                  backgroundColor: "#fafafa",
                }}
              >
                <img src={webpSrc} alt="WebP Optimized" style={{ width: "100%", height: "auto", display: "block" }} />
              </div>
            </BlockStack>
          </div>
        </div>
      </Modal.Section>
    </Modal>
  );
}
