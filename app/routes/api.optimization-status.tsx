import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Get the most recent running or recently completed job
  const job = await db.optimizationJob.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  if (!job) {
    return json({ hasJob: false });
  }

  // Also get fresh stats from the database
  const stats = await db.imageOptimization.groupBy({
    by: ["status"],
    where: { shop },
    _count: { status: true },
  });

  const recentOptimizations = await db.imageOptimization.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  return json({
    hasJob: true,
    job: {
      id: job.id,
      status: job.status,
      totalImages: job.totalImages,
      processedCount: job.processedCount,
      errorCount: job.errorCount,
      skippedCount: job.skippedCount,
      totalSaved: job.totalSaved,
      currentImage: job.currentImage,
      cancelled: job.cancelled,
    },
    stats,
    recentOptimizations,
  });
};
