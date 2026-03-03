import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate, MONTHLY_PLAN } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);

  // Check billing status — redirect to billing page if no active subscription
  // This gates all /app/* routes behind the paywall
  const url = new URL(request.url);
  const isBillingPage = url.pathname === "/app/billing";

  if (!isBillingPage) {
    try {
      await billing.require({
        plans: [MONTHLY_PLAN],
        isTest: process.env.BILLING_TEST_MODE === "true",
        onFailure: async () => {
          throw new Response(null, {
            status: 302,
            headers: { Location: "/app/billing" },
          });
        },
      });
    } catch (response) {
      if (response instanceof Response) {
        throw response;
      }
      // If it's a Shopify redirect (for payment), let it through
      throw response;
    }
  }

  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Home
        </Link>
        <Link to="/app/image-optimizer">Image Optimizer</Link>
        <Link to="/app/settings">SEO Settings</Link>
        <Link to="/app/billing">Billing</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
