import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
  Badge,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";

// ─── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const isTest = process.env.BILLING_TEST_MODE === "true";

  let hasActiveSubscription = false;
  let currentSubscription: {
    name: string;
    status: string;
    trialDays: number | null;
    currentPeriodEnd: string | null;
    test: boolean;
    id: string;
  } | null = null;

  try {
    const billingCheck = await billing.check({
      plans: [MONTHLY_PLAN],
      isTest,
    });

    hasActiveSubscription = billingCheck.hasActivePayment;
    const appSubscriptions = billingCheck.appSubscriptions || [];

    if (appSubscriptions.length > 0) {
      const sub = appSubscriptions[0];
      currentSubscription = {
        name: sub.name,
        status: sub.status,
        trialDays: sub.trialDays ?? null,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        test: sub.test ?? false,
        id: sub.id,
      };
    }
  } catch (error) {
    // BUG-008 FIX: Don't crash if billing check fails
    console.error("Billing check error:", error);
    if (error instanceof Response) {
      throw error; // Re-throw redirect responses
    }
  }

  return json({
    shop: session.shop,
    hasActiveSubscription,
    currentSubscription,
    isTestMode: isTest,
  });
};

// ─── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action") as string;
  const isTest = process.env.BILLING_TEST_MODE === "true";

  if (actionType === "subscribe") {
    try {
      // BUG-008 FIX: billing.request() throws a Response redirect to Shopify's
      // billing approval page. We need to let that throw propagate.
      // The returnUrl must be a valid URL that Shopify can redirect back to.
      const appUrl = process.env.SHOPIFY_APP_URL || "";
      await billing.request({
        plan: MONTHLY_PLAN,
        isTest,
        returnUrl: `${appUrl}/app/billing`,
      });
      // If we somehow get here (shouldn't), return success
      return json({ success: true });
    } catch (error) {
      // billing.request() throws a Response for the redirect — this is EXPECTED
      if (error instanceof Response) {
        throw error; // Re-throw so Remix handles the redirect
      }
      // Actual error
      console.error("Billing request error:", error);
      return json({
        success: false,
        error: `Failed to start subscription: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (actionType === "cancel") {
    try {
      const billingCheck = await billing.check({
        plans: [MONTHLY_PLAN],
        isTest,
      });

      const appSubscriptions = billingCheck.appSubscriptions || [];
      if (appSubscriptions.length > 0) {
        const sub = appSubscriptions[0];
        await billing.cancel({
          subscriptionId: sub.id,
          isTest,
          prorate: true,
        });
        return json({ success: true, cancelled: true });
      }

      return json({ success: false, error: "No active subscription found to cancel" });
    } catch (error) {
      console.error("Cancel error:", error);
      if (error instanceof Response) {
        throw error;
      }
      return json({
        success: false,
        error: `Failed to cancel: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return json({ success: false, error: "Unknown action" });
};

// ─── Component ─────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { hasActiveSubscription, currentSubscription, isTestMode } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const handleSubscribe = () => {
    submit({ action: "subscribe" }, { method: "post" });
  };

  const handleCancel = () => {
    submit({ action: "cancel" }, { method: "post" });
  };

  const features = [
    "Unlimited image optimization",
    "WebP conversion with quality preservation",
    "One-click bulk optimization",
    "Original image backup & safe revert",
    "SEO alt text & filename templates",
    "Real-time progress tracking",
    "Cancel & retry support",
    "Before/after image comparison",
  ];

  return (
    <Page title="Billing" backAction={{ url: "/app" }}>
      <Layout>
        {/* Error banner */}
        {actionData && "error" in actionData && actionData.error && (
          <Layout.Section>
            <Banner tone="critical" title="Billing Error">
              <p>{actionData.error as string}</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Cancellation success */}
        {actionData && "cancelled" in actionData && actionData.cancelled && (
          <Layout.Section>
            <Banner tone="success" title="Subscription Cancelled">
              <p>Your subscription has been cancelled. You can re-subscribe anytime.</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Test mode indicator */}
        {isTestMode && (
          <Layout.Section>
            <Banner tone="info">
              <p>
                Billing is running in <strong>test mode</strong>. No real charges will be made.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Current Plan Status */}
        {hasActiveSubscription && currentSubscription && (
          <Layout.Section>
            <Banner title="Your subscription is active" tone="success">
              <p>
                You're on the <strong>{currentSubscription.name}</strong>.
                {currentSubscription.status === "ACTIVE" &&
                  currentSubscription.trialDays &&
                  currentSubscription.trialDays > 0 &&
                  ` You're currently in your free trial.`}
                {currentSubscription.test && " (Test mode)"}
              </p>
            </Banner>
          </Layout.Section>
        )}

        {!hasActiveSubscription && (
          <Layout.Section>
            <Banner title="Start your free trial" tone="info">
              <p>
                Try Image Compression WebPro free for 7 days. No credit card
                required to start. Cancel anytime.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {/* Plan Card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    WebPro Monthly
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="p" variant="headingXl">
                      $6.99
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      / month
                    </Text>
                  </InlineStack>
                </BlockStack>
                {hasActiveSubscription ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge>Not subscribed</Badge>
                )}
              </InlineStack>

              <Divider />

              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Everything you need to optimize your store images:
              </Text>

              <BlockStack gap="200">
                {features.map((feature, i) => (
                  <InlineStack key={i} gap="200" blockAlign="center">
                    <span style={{ color: "#008060", fontSize: "16px" }}>
                      ✓
                    </span>
                    <Text as="p" variant="bodyMd">
                      {feature}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>

              <Divider />

              <InlineStack gap="200" blockAlign="center">
                <span
                  style={{
                    background: "#F4F6F8",
                    padding: "4px 12px",
                    borderRadius: "8px",
                    fontSize: "13px",
                  }}
                >
                  7-day free trial included
                </span>
                <Text as="p" variant="bodySm" tone="subdued">
                  Cancel anytime — no questions asked
                </Text>
              </InlineStack>

              <Box paddingBlockStart="200">
                {!hasActiveSubscription ? (
                  <Button
                    variant="primary"
                    size="large"
                    fullWidth
                    onClick={handleSubscribe}
                    loading={isSubmitting}
                  >
                    Start Free 7-Day Trial
                  </Button>
                ) : (
                  <BlockStack gap="200">
                    <Button
                      variant="primary"
                      size="large"
                      fullWidth
                      url="/app/image-optimizer"
                    >
                      Go to Image Optimizer
                    </Button>
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={handleCancel}
                      loading={isSubmitting}
                    >
                      Cancel Subscription
                    </Button>
                  </BlockStack>
                )}
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* FAQ */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Frequently Asked Questions
              </Text>

              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    What happens during the free trial?
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    You get full access to all features for 7 days. Your credit
                    card won't be charged until the trial ends. You can cancel
                    anytime during the trial.
                  </Text>
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Can I revert my images after cancelling?
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Yes. All original images are backed up in your Shopify Files.
                    You can revert any optimized image back to the original
                    before cancelling.
                  </Text>
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    How does billing work?
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Billing is handled through Shopify. The $6.99/month charge
                    appears on your regular Shopify invoice. All charges are in
                    USD.
                  </Text>
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Is there a limit on the number of images?
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No. You can optimize unlimited product images with your
                    subscription.
                  </Text>
                </BlockStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
