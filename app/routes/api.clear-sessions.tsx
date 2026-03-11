import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");

  // Simple secret to prevent unauthorized access
  if (secret !== "clear-sessions-2026") {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const deleted = await db.session.deleteMany({});

  return json({
    success: true,
    message: `Deleted ${deleted.count} session(s). Reload the app in Shopify admin to re-authenticate.`,
  });
};
