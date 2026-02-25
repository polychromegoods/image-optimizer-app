// ─── Shopify GraphQL Response Types ────────────────────────────────────────────

export interface ShopifyImage {
  url: string;
  altText: string | null;
  width: number;
  height: number;
}

export interface ShopifyMediaImage {
  id: string;
  image: ShopifyImage;
  mediaContentType: "IMAGE" | string;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  media: {
    edges: Array<{ node: ShopifyMediaImage }>;
  };
}

export interface StagedUploadTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

// ─── Database Model Types ──────────────────────────────────────────────────────

export interface ImageOptimizationRecord {
  id: string;
  shop: string;
  productId: string;
  imageId: string;
  originalUrl: string;
  originalGid: string | null;
  originalAlt: string | null;
  backupUrl: string | null;
  webpUrl: string | null;
  webpGid: string | null;
  status: OptimizationStatus;
  fileSize: number | null;
  webpFileSize: number | null;
  altTextUpdated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type OptimizationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "reverted";

export type JobStatus = "running" | "completed" | "cancelled";

export interface OptimizationJobRecord {
  id: string;
  shop: string;
  status: JobStatus;
  totalImages: number;
  processedCount: number;
  errorCount: number;
  skippedCount: number;
  totalSaved: number;
  currentImage: string | null;
  cancelled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeoSettingsRecord {
  id: string;
  shop: string;
  altTextTemplate: string;
  fileNameTemplate: string;
  autoApplyOnOptimize: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Template Variables ────────────────────────────────────────────────────────

export interface TemplateVariables {
  product_name: string;
  vendor: string;
  product_type: string;
  shop_name: string;
  product_handle: string;
  variant_title: string;
  image_number: string;
}

// ─── Action Response Types ─────────────────────────────────────────────────────

export interface OptimizeActionResult {
  success: boolean;
  actionType: "optimize" | "retry" | "cancelled";
  processedCount: number;
  errorCount: number;
  skippedCount: number;
  totalSaved: number;
  jobId: string;
}

export interface RevertActionResult {
  success: boolean;
  actionType: "revert";
  revertedCount: number;
  errorCount: number;
}

export interface CancelActionResult {
  success: boolean;
  actionType: "cancel";
}

export interface RefreshActionResult {
  success: boolean;
  message: string;
}

export type ActionResult =
  | OptimizeActionResult
  | RevertActionResult
  | CancelActionResult
  | RefreshActionResult
  | { success: boolean; actionType?: string; message?: string };

// ─── Loader Data ───────────────────────────────────────────────────────────────

export interface LoaderData {
  shop: string;
  stats: Array<{
    status: string;
    _count: { status: number };
  }>;
  recentOptimizations: ImageOptimizationRecord[];
  products: ShopifyProduct[];
  totalImages: number;
  newImages: number;
  seoSettings: SeoSettingsRecord | null;
  activeJob: OptimizationJobRecord | null;
}

// ─── Stats Map ─────────────────────────────────────────────────────────────────

export interface StatsMap {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  reverted: number;
  [key: string]: number;
}

// ─── Shopify Admin API (generic wrapper) ───────────────────────────────────────

export interface ShopifyAdmin {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}
