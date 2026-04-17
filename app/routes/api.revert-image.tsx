import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { revertSingleOptimization } from "../lib/optimization-engine";

/**
 * API endpoint to revert a single optimized image back to its original.
 * Used by the Image Browser for per-image revert.
 *
 * POST /api/revert-image
 * Body: { optimizationId }
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const { optimizationId } = body;

  if (!optimizationId) {
    return json({ success: false, error: "optimizationId is required" }, { status: 400 });
  }

  try {
    const opt = await db.imageOptimization.findUnique({
      where: { id: optimizationId },
    });

    if (!opt) {
      return json({ success: false, error: "Optimization record not found" }, { status: 404 });
    }

    if (opt.status !== "completed") {
      return json({ success: false, error: "Only completed optimizations can be reverted" }, { status: 400 });
    }

    if (opt.shop !== shop) {
      return json({ success: false, error: "Unauthorized" }, { status: 403 });
    }

    await revertSingleOptimization(admin, {
      ...opt,
      shop,
    });

    return json({ success: true });
  } catch (error) {
    console.error("[api.revert-image] Error:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to revert image",
    }, { status: 500 });
  }
};
