import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  Link,
  Outlet,
  useLoaderData,
  useRouteError,
  useNavigate,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { useEffect } from "react";

import { authenticate, MONTHLY_PLAN } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);

  const url = new URL(request.url);
  const isBillingPage = url.pathname === "/app/billing";

  let needsBilling = false;

  if (!isBillingPage) {
    const billingCheck = await billing.check({
      plans: [MONTHLY_PLAN],
      isTest: process.env.BILLING_TEST_MODE === "true",
    });
    needsBilling = !billingCheck.hasActivePayment;
  }

  return json({
    apiKey: process.env.SHOPIFY_API_KEY || "",
    needsBilling,
  });
};

export default function App() {
  const { apiKey, needsBilling } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  useEffect(() => {
    if (needsBilling) {
      navigate("/app/billing");
    }
  }, [needsBilling, navigate]);

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
