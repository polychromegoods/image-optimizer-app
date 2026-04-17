import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  Text,
  TextField,
  InlineStack,
  Badge,
  Spinner,
  Thumbnail,
  Banner,
  Icon,
  EmptyState,
  Filters,
  ChoiceList,
  Box,
  InlineGrid,
  Divider,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useState, useCallback, useRef, useEffect } from "react";
import { authenticate } from "../shopify.server";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface ProductImage {
  id: string;
  url: string;
  altText: string | null;
  width: number;
  height: number;
  optimizationStatus: "new" | "completed" | "failed" | "processing";
  optimizationId: string | null;
  isWebpVersion: boolean;
  originalSize?: number | null;
  webpSize?: number | null;
  savings?: string | null;
}

interface Product {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  featuredImageUrl: string | null;
  imageCount: number;
  images: ProductImage[];
}

// ─── Loader ─────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ ok: true });
};

// ─── Component ──────────────────────────────────────────────────────────────────

export default function ImageBrowser() {
  const [searchQuery, setSearchQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [pageInfo, setPageInfo] = useState<{ hasNextPage: boolean; endCursor: string | null }>({
    hasNextPage: false,
    endCursor: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);

  // Track per-image loading states
  const [compressingImages, setCompressingImages] = useState<Set<string>>(new Set());
  const [revertingImages, setRevertingImages] = useState<Set<string>>(new Set());
  const [actionResults, setActionResults] = useState<Map<string, { success: boolean; message: string }>>(new Map());

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search products ──
  const fetchProducts = useCallback(async (query: string, cursor?: string | null) => {
    const isLoadMore = !!cursor;
    if (isLoadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setError(null);
    }

    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (cursor) params.set("cursor", cursor);

      const resp = await fetch(`/api/search-products?${params.toString()}`, {
        credentials: "same-origin",
      });

      if (!resp.ok) throw new Error("Failed to fetch products");

      const data = await resp.json();

      if (isLoadMore) {
        setProducts((prev) => [...prev, ...data.products]);
      } else {
        setProducts(data.products);
      }
      setPageInfo(data.pageInfo);
      setHasSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search products");
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, []);

  // ── Auto-search on mount (show all products) ──
  useEffect(() => {
    fetchProducts("");
  }, [fetchProducts]);

  // ── Debounced search ──
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        fetchProducts(value);
      }, 400);
    },
    [fetchProducts],
  );

  // ── Compress single image ──
  const handleCompress = useCallback(async (imageId: string, productId: string) => {
    setCompressingImages((prev) => new Set(prev).add(imageId));
    setActionResults((prev) => {
      const next = new Map(prev);
      next.delete(imageId);
      return next;
    });

    try {
      const resp = await fetch("/api/compress-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ imageId, productId }),
      });

      const data = await resp.json();

      if (data.success) {
        // Update the product's image status in state
        setProducts((prev) =>
          prev.map((p) => ({
            ...p,
            images: p.images.map((img) =>
              img.id === imageId
                ? {
                    ...img,
                    optimizationStatus: "completed" as const,
                    optimizationId: data.optimization?.id || img.optimizationId,
                    originalSize: data.optimization?.fileSize,
                    webpSize: data.optimization?.webpFileSize,
                    savings: data.optimization?.savings,
                  }
                : img,
            ),
          })),
        );
        setActionResults((prev) => new Map(prev).set(imageId, { success: true, message: "Compressed successfully" }));
      } else {
        setActionResults((prev) => new Map(prev).set(imageId, { success: false, message: data.error || "Failed to compress" }));
      }
    } catch (err) {
      setActionResults((prev) =>
        new Map(prev).set(imageId, { success: false, message: err instanceof Error ? err.message : "Network error" }),
      );
    } finally {
      setCompressingImages((prev) => {
        const next = new Set(prev);
        next.delete(imageId);
        return next;
      });
    }
  }, []);

  // ── Revert single image ──
  const handleRevert = useCallback(async (imageId: string, optimizationId: string) => {
    setRevertingImages((prev) => new Set(prev).add(imageId));
    setActionResults((prev) => {
      const next = new Map(prev);
      next.delete(imageId);
      return next;
    });

    try {
      const resp = await fetch("/api/revert-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ optimizationId }),
      });

      const data = await resp.json();

      if (data.success) {
        // Update the product's image status in state
        setProducts((prev) =>
          prev.map((p) => ({
            ...p,
            images: p.images.map((img) =>
              img.id === imageId
                ? {
                    ...img,
                    optimizationStatus: "new" as const,
                    optimizationId: null,
                    isWebpVersion: false,
                    originalSize: null,
                    webpSize: null,
                    savings: null,
                  }
                : img,
            ),
          })),
        );
        setActionResults((prev) => new Map(prev).set(imageId, { success: true, message: "Reverted to original" }));
      } else {
        setActionResults((prev) => new Map(prev).set(imageId, { success: false, message: data.error || "Failed to revert" }));
      }
    } catch (err) {
      setActionResults((prev) =>
        new Map(prev).set(imageId, { success: false, message: err instanceof Error ? err.message : "Network error" }),
      );
    } finally {
      setRevertingImages((prev) => {
        const next = new Set(prev);
        next.delete(imageId);
        return next;
      });
    }
  }, []);

  // ── Compress all new images for a product ──
  const handleCompressAllForProduct = useCallback(
    async (product: Product) => {
      const newImages = product.images.filter(
        (img) => img.optimizationStatus === "new" || img.optimizationStatus === "failed",
      );
      for (const img of newImages) {
        await handleCompress(img.id, product.id);
      }
    },
    [handleCompress],
  );

  // ── Filter products by status ──
  const filteredProducts = statusFilter.length > 0
    ? products
        .map((p) => ({
          ...p,
          images: p.images.filter((img) => statusFilter.includes(img.optimizationStatus)),
        }))
        .filter((p) => p.images.length > 0)
    : products;

  // ── Stats ──
  const totalImages = products.reduce((sum, p) => sum + p.images.length, 0);
  const newCount = products.reduce(
    (sum, p) => sum + p.images.filter((img) => img.optimizationStatus === "new").length,
    0,
  );
  const optimizedCount = products.reduce(
    (sum, p) => sum + p.images.filter((img) => img.optimizationStatus === "completed").length,
    0,
  );
  const failedCount = products.reduce(
    (sum, p) => sum + p.images.filter((img) => img.optimizationStatus === "failed").length,
    0,
  );

  return (
    <Page
      title="Image Browser"
      subtitle="Search products and compress individual images. Browse your full image library."
      backAction={{ url: "/app/image-optimizer" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {error && (
              <Banner tone="critical" onDismiss={() => setError(null)}>
                <p>{error}</p>
              </Banner>
            )}

            {/* Search and filter bar */}
            <Card>
              <BlockStack gap="400">
                <TextField
                  label="Search products"
                  labelHidden
                  placeholder="Search products by name..."
                  value={searchQuery}
                  onChange={handleSearchChange}
                  autoComplete="off"
                  prefix={<Icon source={SearchIcon} />}
                  clearButton
                  onClearButtonClick={() => {
                    setSearchQuery("");
                    fetchProducts("");
                  }}
                />
                <InlineStack gap="300" align="space-between">
                  <InlineStack gap="200">
                    <Badge tone="info">{totalImages} images</Badge>
                    <Badge tone="success">{optimizedCount} optimized</Badge>
                    {newCount > 0 && <Badge>{newCount} uncompressed</Badge>}
                    {failedCount > 0 && <Badge tone="critical">{failedCount} failed</Badge>}
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button
                      size="slim"
                      pressed={statusFilter.includes("new")}
                      onClick={() =>
                        setStatusFilter((prev) =>
                          prev.includes("new") ? prev.filter((s) => s !== "new") : [...prev, "new"],
                        )
                      }
                    >
                      Uncompressed
                    </Button>
                    <Button
                      size="slim"
                      pressed={statusFilter.includes("completed")}
                      onClick={() =>
                        setStatusFilter((prev) =>
                          prev.includes("completed")
                            ? prev.filter((s) => s !== "completed")
                            : [...prev, "completed"],
                        )
                      }
                    >
                      Optimized
                    </Button>
                    <Button
                      size="slim"
                      pressed={statusFilter.includes("failed")}
                      onClick={() =>
                        setStatusFilter((prev) =>
                          prev.includes("failed")
                            ? prev.filter((s) => s !== "failed")
                            : [...prev, "failed"],
                        )
                      }
                    >
                      Failed
                    </Button>
                    {statusFilter.length > 0 && (
                      <Button size="slim" onClick={() => setStatusFilter([])}>
                        Clear filters
                      </Button>
                    )}
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Loading state */}
            {isLoading && (
              <Card>
                <div style={{ display: "flex", justifyContent: "center", padding: "40px" }}>
                  <Spinner size="large" />
                </div>
              </Card>
            )}

            {/* Empty state */}
            {!isLoading && hasSearched && filteredProducts.length === 0 && (
              <Card>
                <EmptyState
                  heading={searchQuery ? "No products found" : "No images to show"}
                  image=""
                >
                  <p>
                    {searchQuery
                      ? `No products match "${searchQuery}". Try a different search term.`
                      : statusFilter.length > 0
                        ? "No images match the selected filters."
                        : "Your store has no product images yet."}
                  </p>
                </EmptyState>
              </Card>
            )}

            {/* Product cards with image grids */}
            {!isLoading &&
              filteredProducts.map((product) => (
                <ProductImageCard
                  key={product.id}
                  product={product}
                  compressingImages={compressingImages}
                  revertingImages={revertingImages}
                  actionResults={actionResults}
                  onCompress={handleCompress}
                  onRevert={handleRevert}
                  onCompressAll={handleCompressAllForProduct}
                />
              ))}

            {/* Load more */}
            {!isLoading && pageInfo.hasNextPage && (
              <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}>
                <Button
                  onClick={() => fetchProducts(searchQuery, pageInfo.endCursor)}
                  loading={isLoadingMore}
                >
                  Load More Products
                </Button>
              </div>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Product Image Card ─────────────────────────────────────────────────────────

function ProductImageCard({
  product,
  compressingImages,
  revertingImages,
  actionResults,
  onCompress,
  onRevert,
  onCompressAll,
}: {
  product: Product;
  compressingImages: Set<string>;
  revertingImages: Set<string>;
  actionResults: Map<string, { success: boolean; message: string }>;
  onCompress: (imageId: string, productId: string) => void;
  onRevert: (imageId: string, optimizationId: string) => void;
  onCompressAll: (product: Product) => void;
}) {
  const newImages = product.images.filter(
    (img) => img.optimizationStatus === "new" || img.optimizationStatus === "failed",
  );
  const optimizedImages = product.images.filter((img) => img.optimizationStatus === "completed");

  return (
    <Card>
      <BlockStack gap="400">
        {/* Product header */}
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            {product.featuredImageUrl ? (
              <Thumbnail source={product.featuredImageUrl} alt={product.title} size="small" />
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
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                {product.title}
              </Text>
              <InlineStack gap="200">
                <Text as="span" variant="bodySm" tone="subdued">
                  {product.images.length} image{product.images.length !== 1 ? "s" : ""}
                </Text>
                {optimizedImages.length > 0 && (
                  <Badge tone="success">{optimizedImages.length} optimized</Badge>
                )}
                {newImages.length > 0 && <Badge>{newImages.length} uncompressed</Badge>}
              </InlineStack>
            </BlockStack>
          </InlineStack>
          {newImages.length > 0 && (
            <Button
              variant="primary"
              size="slim"
              onClick={() => onCompressAll(product)}
              disabled={newImages.every((img) => compressingImages.has(img.id))}
            >
              Compress All ({newImages.length})
            </Button>
          )}
        </InlineStack>

        <Divider />

        {/* Image grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "16px",
          }}
        >
          {product.images.map((img) => (
            <ImageTile
              key={img.id}
              image={img}
              productId={product.id}
              isCompressing={compressingImages.has(img.id)}
              isReverting={revertingImages.has(img.id)}
              actionResult={actionResults.get(img.id)}
              onCompress={onCompress}
              onRevert={onRevert}
            />
          ))}
        </div>
      </BlockStack>
    </Card>
  );
}

// ─── Image Tile ─────────────────────────────────────────────────────────────────

function ImageTile({
  image,
  productId,
  isCompressing,
  isReverting,
  actionResult,
  onCompress,
  onRevert,
}: {
  image: ProductImage;
  productId: string;
  isCompressing: boolean;
  isReverting: boolean;
  actionResult?: { success: boolean; message: string };
  onCompress: (imageId: string, productId: string) => void;
  onRevert: (imageId: string, optimizationId: string) => void;
}) {
  const statusBadge = (() => {
    switch (image.optimizationStatus) {
      case "completed":
        return <Badge tone="success">Optimized</Badge>;
      case "failed":
        return <Badge tone="critical">Failed</Badge>;
      case "processing":
        return <Badge tone="attention">Processing</Badge>;
      default:
        return <Badge>Uncompressed</Badge>;
    }
  })();

  return (
    <div
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: "12px",
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {/* Image preview */}
      <div
        style={{
          position: "relative",
          width: "100%",
          paddingTop: "100%",
          background: "#f6f6f7",
          overflow: "hidden",
        }}
      >
        <img
          src={image.url}
          alt={image.altText || "Product image"}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
          loading="lazy"
        />
        {/* Overlay spinner when compressing/reverting */}
        {(isCompressing || isReverting) && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              background: "rgba(255,255,255,0.8)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <Spinner size="large" />
            <Text as="span" variant="bodySm">
              {isCompressing ? "Compressing..." : "Reverting..."}
            </Text>
          </div>
        )}
      </div>

      {/* Image info and actions */}
      <div style={{ padding: "12px" }}>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            {statusBadge}
            {image.savings && (
              <Text as="span" variant="bodySm" tone="success" fontWeight="semibold">
                -{image.savings}%
              </Text>
            )}
          </InlineStack>

          {/* Size info */}
          {image.originalSize && (
            <Text as="p" variant="bodySm" tone="subdued">
              {(image.originalSize / 1024).toFixed(0)} KB
              {image.webpSize ? ` → ${(image.webpSize / 1024).toFixed(0)} KB` : ""}
            </Text>
          )}

          {/* Dimensions */}
          {image.width && image.height && (
            <Text as="p" variant="bodySm" tone="subdued">
              {image.width} x {image.height}
            </Text>
          )}

          {/* Action result message */}
          {actionResult && (
            <Text
              as="p"
              variant="bodySm"
              tone={actionResult.success ? "success" : "critical"}
            >
              {actionResult.message}
            </Text>
          )}

          {/* Action buttons */}
          <InlineStack gap="200">
            {(image.optimizationStatus === "new" || image.optimizationStatus === "failed") && (
              <Button
                size="slim"
                variant="primary"
                onClick={() => onCompress(image.id, productId)}
                loading={isCompressing}
                disabled={isReverting}
              >
                Compress
              </Button>
            )}
            {image.optimizationStatus === "completed" && image.optimizationId && (
              <Button
                size="slim"
                tone="critical"
                onClick={() => onRevert(image.id, image.optimizationId!)}
                loading={isReverting}
                disabled={isCompressing}
              >
                Revert
              </Button>
            )}
          </InlineStack>
        </BlockStack>
      </div>
    </div>
  );
}
