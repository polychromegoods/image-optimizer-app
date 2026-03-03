# QA Test Plan — Image Compression WebPro (Shopify App)

**Version:** 1.0
**Date:** February 25, 2026
**App:** Image Compression WebPro
**Platform:** Shopify Admin (Embedded App)
**Deployment:** Railway (auto-deploy from GitHub `main` branch)

---

## 1. Overview

This document provides a comprehensive manual QA test plan for the Image Compression WebPro Shopify app. The app optimizes product images by converting them to WebP format, manages backups for safe revert, applies SEO alt text/filenames, and provides real-time progress tracking with cancellation support.

### Scope

| Area | Covered |
|---|---|
| Image optimization (WebP conversion) | Yes |
| Backup and revert (single + bulk) | Yes |
| Cancel in-progress optimization | Yes |
| Live progress updates (polling) | Yes |
| Retry failed images | Yes |
| SEO alt text & filename templates | Yes |
| Compare modal (original vs WebP) | Yes |
| Edge cases & error handling | Yes |
| Cross-browser compatibility | Yes |
| Performance under load | Yes |
| Billing & subscription (trial, subscribe, cancel) | Yes |

### Prerequisites

- A Shopify development/test store with at least 5 products, each having 2-5 images (mix of PNG, JPG, and large images)
- The app installed on the test store
- Access to Shopify Admin > Products, Content > Files, and the app dashboard
- A stable internet connection (some tests involve large file uploads)
- The environment variable `BILLING_TEST_MODE=true` must be set on Railway (this enables test billing so dev stores can subscribe without real charges)

---

## 2. Test Environment Setup

| Item | Details |
|---|---|
| Shopify Store | Development store (free, created via Dev Dashboard) |
| App URL | `https://image-optimizer-app-production.up.railway.app` |
| App Client ID | `245ba33ff3fdd13456646e458c9332e0` |
| Browser | Chrome (latest), Firefox (latest), Safari (latest) |
| Billing Mode | Test mode (`BILLING_TEST_MODE=true` on Railway) — no real charges |

### Step 1: Create a Shopify Partner Account (if you don't have one)

1. Go to [https://partners.shopify.com](https://partners.shopify.com) and click **Join now**.
2. Fill in your name, email, and password. You do not need a paid Shopify plan — Partner accounts are free.
3. Complete the onboarding questions (select "I'm building apps" or similar).
4. Verify your email address.

### Step 2: Create a Development Store

Development stores are free test stores where you can install and test apps without processing real transactions.

1. Log in to the [Shopify Dev Dashboard](https://dev.shopify.com).
2. Click **Dev stores** in the left sidebar.
3. Click **Add dev store**.
4. Enter a store name (e.g., `qa-image-optimizer-test`).
5. Select a plan — **Basic** is fine for testing.
6. Click **Create store**.
7. Once created, click the store name to open its Shopify Admin. Bookmark this URL (it will look like `https://admin.shopify.com/store/qa-image-optimizer-test`).

> **Note:** Dev stores cannot process real payments and have a password-protected storefront. This is expected and does not affect app testing.

### Step 3: Install the App on Your Dev Store

The app is deployed at `https://image-optimizer-app-production.up.railway.app`. To install it:

1. Open your dev store's Shopify Admin.
2. Navigate to the app install URL in your browser:
   ```
   https://image-optimizer-app-production.up.railway.app/auth?shop=YOUR-STORE-NAME.myshopify.com
   ```
   Replace `YOUR-STORE-NAME` with your actual dev store subdomain (e.g., `qa-image-optimizer-test`).
3. Shopify will show a permissions screen requesting access to **read/write products** and **read/write files**. Click **Install app**.
4. You should be redirected to the app's Image Optimizer page inside Shopify Admin.
5. Verify the app appears under **Apps** in the left sidebar of your Shopify Admin.

> **Troubleshooting:** If you see an error during installation, confirm that:
> - Your store URL is correct (must end in `.myshopify.com`)
> - You are logged in as the store owner
> - The app server is running (visit the App URL directly — it should not show a 502 error)

### Step 4: Add Test Products with Images

You need products with images to test the optimizer. You can add them manually or use Shopify's sample data.

**Option A — Add products manually:**

1. In Shopify Admin, go to **Products** > **Add product**.
2. Create at least **5 products** with the following image configurations:

| Product | Images | Details |
|---|---|---|
| Product A | 1 image | Small file, < 50 KB, PNG format |
| Product B | 3 images | Medium files, 100–500 KB each, JPG format |
| Product C | 5 images | Large files, > 1 MB each, PNG format |
| Product D | 1 image | Already in WebP format |
| Product E | 2 images | Any format, but add custom alt text to both images |

3. For each product, fill in the **Title**, **Vendor**, and **Product type** fields (these are used by the SEO template feature).
4. Save each product.

**Option B — Use Shopify's sample data (faster):**

1. In Shopify Admin, go to **Settings** > **Plan**.
2. Look for the option to **Add sample data** or use the Shopify CLI command:
   ```
   shopify populate products --count 10
   ```
3. This creates products with placeholder images. You may want to replace some images with larger files to test compression savings.

**After adding products:**

5. Note the original file sizes (visible in **Content** > **Files** in Shopify Admin) and any existing alt text.
6. Take screenshots of the products page for before/after comparison.

### Step 5: Verify the App Is Working

1. Open the app from **Apps** > **Image Compression WebPro** in Shopify Admin.
2. Click the **Refresh** button to sync your product images.
3. You should see a count of images ready to optimize (e.g., "Optimize 12 New Images").
4. If the count is 0, verify that your products have images and try refreshing again.

You are now ready to begin testing. Proceed to **Section 3: Test Cases**.

---

## 3. Test Cases

### 3.1 — App Installation & Navigation

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| NAV-01 | App loads in Shopify Admin | Open the app from Shopify Admin > Apps | App loads within the Shopify Admin iframe, showing "Image Optimizer" page title | P0 |
| NAV-02 | Navigation to Settings | Click "Settings" or navigate to `/app/settings` | Settings page loads with alt text and filename template fields | P0 |
| NAV-03 | Navigation back to Optimizer | From Settings, navigate back to Image Optimizer | Optimizer page loads with current stats | P1 |

### 3.2 — Refresh / Sync Images

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| REF-01 | Refresh detects new images | Click "Refresh" button | Page reloads, "Found X new images ready to optimize" banner appears | P0 |
| REF-02 | Refresh with no new images | Click "Refresh" when all images are already tracked | "No New Images to Optimize" button remains disabled | P1 |
| REF-03 | Refresh after adding a product | Add a new product with images in Shopify, then click Refresh | New images are detected and count increases | P0 |
| REF-04 | Refresh button disabled during optimization | Start optimization, then check Refresh button | Refresh button should be disabled/greyed out | P1 |

### 3.3 — Image Optimization

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| OPT-01 | Optimize all new images | Click "Optimize X New Images" button | Optimization starts, live progress card appears with spinner and progress bar | P0 |
| OPT-02 | Progress bar updates in real-time | Watch the live progress card during optimization | Counter increments ("X of Y images processed"), progress bar fills, current image name shown | P0 |
| OPT-03 | Savings counter updates | Watch "Saved so far" during optimization | Green text shows cumulative KB saved, increasing with each image | P1 |
| OPT-04 | Optimization completes successfully | Wait for all images to finish | Green "Optimization Complete" banner appears with processed/skipped/error counts and total saved | P0 |
| OPT-05 | Already-optimized images are skipped | Run optimization again after completing once | Images with "completed" status are skipped; skipped count shown | P0 |
| OPT-06 | WebP file is smaller than original | Check the results table after optimization | WebP size column shows smaller value than Original; Savings column shows positive percentage | P0 |
| OPT-07 | Product media is replaced in Shopify | Go to Shopify Admin > Products > [optimized product] | Product images should now be WebP format | P0 |
| OPT-08 | Backup is created in Shopify Files | Go to Shopify Admin > Content > Files | Backup files (named `backup-XXXXX.png/jpg`) should exist | P0 |
| OPT-09 | Duplicate progress bar not shown | During optimization, check the page layout | Only the live progress card should be visible; the static "Optimization Progress" card should be hidden | P1 |

### 3.4 — Cancel Optimization

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| CAN-01 | Cancel button is visible during optimization | Start optimization | Red "Cancel" button appears in the live progress card | P0 |
| CAN-02 | Cancel stops processing | Click "Cancel" during optimization | Processing stops within a few seconds; yellow "Optimization Cancelled" banner appears | P0 |
| CAN-03 | Already-processed images are kept | After cancelling, check the results table | Images processed before cancel show "completed" status with valid WebP URLs | P0 |
| CAN-04 | Unprocessed images remain pending | After cancelling, check remaining images | Images not yet processed should still show "pending" or not appear in the table | P1 |
| CAN-05 | Can optimize again after cancel | After cancelling, click "Optimize X New Images" | Remaining unprocessed images are optimized in a new run | P0 |
| CAN-06 | Cancel button shows loading state | Click Cancel and observe | Button shows loading spinner while cancel is being processed | P2 |

### 3.5 — Revert (Single Image)

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| REV-01 | Revert button visible for completed images | Check the Actions column for a "completed" row | "Revert" button is visible | P0 |
| REV-02 | Single revert restores original | Click "Revert" on a completed image | Status changes to "reverted"; original image is restored on the product in Shopify Admin | P0 |
| REV-03 | Reverted image uses backup URL | After reverting, check the product in Shopify | Image should be the original (not corrupted or missing) | P0 |
| REV-04 | Reverted image can be re-optimized | After reverting, click Refresh then Optimize | The reverted image appears as a new image and can be optimized again | P1 |

### 3.6 — Revert All

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| RVA-01 | Revert All button visible when images are optimized | Check the Optimization Progress card | "Revert All to Originals" button is visible when completed count > 0 | P0 |
| RVA-02 | Confirmation modal appears | Click "Revert All to Originals" | Modal appears asking to confirm, showing the count of images to revert | P0 |
| RVA-03 | Cancel the modal | Click "Cancel" in the confirmation modal | Modal closes, no action taken | P1 |
| RVA-04 | Revert All restores all images | Click "Revert All" in the modal | All completed images are reverted; banner shows "Reverted X images back to originals" | P0 |
| RVA-05 | All products show original images | After Revert All, check products in Shopify Admin | All products should display their original (non-WebP) images | P0 |
| RVA-06 | Revert All with mixed statuses | Have some completed, some failed, some pending images | Only "completed" images are reverted; failed/pending are untouched | P1 |

### 3.7 — Retry Failed Images

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| RTY-01 | Retry button visible for failed images | Check the Actions column for a "failed" row | Blue "Retry" button is visible | P0 |
| RTY-02 | Retry processes the failed image | Click "Retry" on a failed image | Image is re-processed; status changes to "completed" if successful | P0 |
| RTY-03 | Retry shows result banner | After retry completes | "Retry Complete" banner appears with processed/error counts | P1 |
| RTY-04 | Retry on permanently failing image | Retry an image that will always fail (e.g., deleted source) | Status remains "failed"; error count increments | P1 |

### 3.8 — Compare Modal

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| CMP-01 | Compare button opens modal | Click "Compare" on a completed row | Modal opens showing "Compare: Original vs WebP" title | P0 |
| CMP-02 | Thumbnail click opens modal | Click the thumbnail of a completed image | Same compare modal opens | P1 |
| CMP-03 | Original image displayed | Check the left side of the modal | Original image is shown with its file size in KB | P0 |
| CMP-04 | WebP image displayed | Check the right side of the modal | WebP image is shown with its file size and "X% smaller" text | P0 |
| CMP-05 | Close modal | Click "Close" button or click outside the modal | Modal closes | P1 |
| CMP-06 | Images are visually comparable | Compare both images visually | Both images should look nearly identical in quality | P1 |

### 3.9 — SEO Settings

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| SEO-01 | Default templates are set | Open Settings page for the first time | Alt text template defaults to `#product_name#`, filename to `#product_name#` | P1 |
| SEO-02 | Save custom templates | Change templates and click "Save" | Green "Settings Saved" banner appears | P0 |
| SEO-03 | Preview updates in real-time | Type in the template fields | Preview text below the field updates as you type | P1 |
| SEO-04 | Templates applied during optimization | Enable "Auto-apply", set templates, then optimize | Optimized images have alt text and filenames matching the templates | P0 |
| SEO-05 | Apply SEO Now button | Click "Apply Alt Text Now" | Alt text is updated on all product images; banner shows count | P1 |
| SEO-06 | Template variables replaced correctly | Use `#product_name# by #vendor# - Image #image_number#` | Alt text reads e.g., "Blue Mug by My Brand - Image 1" | P0 |
| SEO-07 | Auto-apply banner on optimizer page | Enable auto-apply in Settings, go to Optimizer | Info banner says "SEO alt text and filenames will be applied automatically" | P2 |

### 3.10 — Results Table

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| TBL-01 | Table shows recent optimizations | After optimizing, check the table | Table shows rows with Preview, Product, Status, Original, WebP, Savings, Actions columns | P0 |
| TBL-02 | Thumbnails are displayed | Check the Preview column | Small thumbnail images are shown for each row | P1 |
| TBL-03 | Product names are shown | Check the Product column | Product title is displayed (not raw GID) | P1 |
| TBL-04 | Status badges have correct colors | Check the Status column | completed=green, failed=red, processing=yellow, reverted=orange, pending=blue | P1 |
| TBL-05 | Table updates during optimization | Watch the table while optimization runs | Rows update from "processing" to "completed" or "failed" in real-time | P0 |
| TBL-06 | Table shows up to 50 rows | Optimize more than 50 images | Table shows the 50 most recent optimizations | P2 |

### 3.11 — Edge Cases & Error Handling

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| ERR-01 | Optimize with no products | Remove all products, click Refresh then Optimize | "No New Images to Optimize" button is disabled | P1 |
| ERR-02 | Optimize with deleted product image | Delete a product image in Shopify while optimization is running | That image fails gracefully; other images continue processing | P1 |
| ERR-03 | Network interruption during optimization | Disconnect network briefly during optimization | App recovers; failed images show "failed" status with Retry option | P1 |
| ERR-04 | Revert when backup URL is missing | Attempt to revert an image optimized before the backup feature was added | Revert attempts using originalUrl; may fail gracefully with error count | P1 |
| ERR-05 | Very large image (> 10 MB) | Add a product with a 10+ MB image, optimize | Image is processed (may take longer); no timeout crash | P2 |
| ERR-06 | Already WebP image | Add a product with a .webp image, optimize | Image is either skipped or re-compressed; no error | P2 |
| ERR-07 | Concurrent optimization attempts | Open app in two browser tabs, click Optimize in both | Only one optimization runs; second is blocked or handled gracefully | P2 |
| ERR-08 | Browser refresh during optimization | Refresh the browser page while optimization is running | Optimization continues server-side; page reloads and shows live progress | P1 |

### 3.12 — Performance

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| PRF-01 | Optimize 10 images | Optimize a batch of 10 images | Completes within 5 minutes | P1 |
| PRF-02 | Optimize 100+ images | Optimize a batch of 100+ images | Completes without timeout; progress updates remain responsive | P1 |
| PRF-03 | Polling does not degrade performance | Monitor browser DevTools Network tab during optimization | Polling requests are small (< 5 KB) and occur every ~2 seconds | P2 |
| PRF-04 | Page load time | Navigate to the Image Optimizer page | Page loads within 3 seconds | P2 |

### 3.13 — Billing & Subscription

> **Important:** All billing tests must be run with `BILLING_TEST_MODE=true` set as an environment variable on Railway. This enables Shopify's test billing mode, which allows dev stores to go through the full subscription flow without real charges. To set this:
> 1. Go to your Railway dashboard > image-optimizer-app service > Variables
> 2. Add `BILLING_TEST_MODE` = `true`
> 3. Redeploy the service

| ID | Test Case | Steps | Expected Result | Priority |
|---|---|---|---|---|
| BIL-01 | New user redirected to billing | Install the app on a fresh dev store and open it | User is redirected to the Billing page (not the optimizer) since they have no active subscription | P0 |
| BIL-02 | Billing page shows plan details | View the Billing page | Page shows "WebPro Monthly" plan at $6.99/month with feature list, 7-day trial badge, and "Start Free 7-Day Trial" button | P0 |
| BIL-03 | Subscribe with free trial | Click "Start Free 7-Day Trial" | Shopify redirects to a payment approval page. Approve the charge. User is redirected back to the app. The billing page shows "Active" badge and subscription details | P0 |
| BIL-04 | Trial indicator shown | After subscribing, check the billing page | Banner says "Your subscription is active" and mentions the free trial if still within the 7-day window | P1 |
| BIL-05 | App features accessible after subscribing | After subscribing, navigate to Image Optimizer and Settings | Both pages load normally without being redirected to billing | P0 |
| BIL-06 | Cancel subscription | On the billing page, click "Cancel Subscription" | Subscription is cancelled. The billing page updates to show "Not subscribed" badge and the "Start Free 7-Day Trial" button reappears | P0 |
| BIL-07 | App gated after cancellation | After cancelling, try to navigate to Image Optimizer | User is redirected back to the Billing page | P0 |
| BIL-08 | Re-subscribe after cancellation | After cancelling, click "Start Free 7-Day Trial" again | Shopify payment flow starts. After approval, app is accessible again | P1 |
| BIL-09 | Billing page accessible without subscription | While not subscribed, navigate directly to /app/billing | Billing page loads (it is not gated behind the paywall) | P1 |
| BIL-10 | Test mode indicator | After subscribing in test mode, check billing page | "(Test mode)" text appears next to subscription status | P2 |
| BIL-11 | Billing nav link | Check the app navigation sidebar | "Billing" link appears in the nav menu alongside Home, Image Optimizer, and SEO Settings | P1 |
| BIL-12 | FAQ section visible | Scroll down on the billing page | FAQ section with 4 questions about trial, reverting, billing, and image limits is visible | P2 |

---

## 4. Test Execution Checklist

Use this checklist during QA testing. Mark each test as Pass (P), Fail (F), Blocked (B), or Skipped (S).

| ID | Result | Notes |
|---|---|---|
| NAV-01 | | |
| NAV-02 | | |
| NAV-03 | | |
| REF-01 | | |
| REF-02 | | |
| REF-03 | | |
| REF-04 | | |
| OPT-01 | | |
| OPT-02 | | |
| OPT-03 | | |
| OPT-04 | | |
| OPT-05 | | |
| OPT-06 | | |
| OPT-07 | | |
| OPT-08 | | |
| OPT-09 | | |
| CAN-01 | | |
| CAN-02 | | |
| CAN-03 | | |
| CAN-04 | | |
| CAN-05 | | |
| CAN-06 | | |
| REV-01 | | |
| REV-02 | | |
| REV-03 | | |
| REV-04 | | |
| RVA-01 | | |
| RVA-02 | | |
| RVA-03 | | |
| RVA-04 | | |
| RVA-05 | | |
| RVA-06 | | |
| RTY-01 | | |
| RTY-02 | | |
| RTY-03 | | |
| RTY-04 | | |
| CMP-01 | | |
| CMP-02 | | |
| CMP-03 | | |
| CMP-04 | | |
| CMP-05 | | |
| CMP-06 | | |
| SEO-01 | | |
| SEO-02 | | |
| SEO-03 | | |
| SEO-04 | | |
| SEO-05 | | |
| SEO-06 | | |
| SEO-07 | | |
| TBL-01 | | |
| TBL-02 | | |
| TBL-03 | | |
| TBL-04 | | |
| TBL-05 | | |
| TBL-06 | | |
| ERR-01 | | |
| ERR-02 | | |
| ERR-03 | | |
| ERR-04 | | |
| ERR-05 | | |
| ERR-06 | | |
| ERR-07 | | |
| ERR-08 | | |
| PRF-01 | | |
| PRF-02 | | |
| PRF-03 | | |
| PRF-04 | | |
| BIL-01 | | |
| BIL-02 | | |
| BIL-03 | | |
| BIL-04 | | |
| BIL-05 | | |
| BIL-06 | | |
| BIL-07 | | |
| BIL-08 | | |
| BIL-09 | | |
| BIL-10 | | |
| BIL-11 | | |
| BIL-12 | | |

---

## 5. Bug Reporting Template

When a test fails, file a bug using this format:

```
**Bug ID:** [auto-increment]
**Test Case ID:** [e.g., OPT-03]
**Severity:** P0 (blocker) / P1 (major) / P2 (minor) / P3 (cosmetic)
**Summary:** [One-line description]
**Steps to Reproduce:**
1. ...
2. ...
3. ...
**Expected Result:** [What should happen]
**Actual Result:** [What actually happened]
**Screenshots/Videos:** [Attach if applicable]
**Browser/OS:** [e.g., Chrome 122 / macOS 14.3]
**Notes:** [Any additional context]
```

---

## 6. Sign-Off

| Role | Name | Date | Signature |
|---|---|---|---|
| QA Tester | | | |
| Developer | | | |
| Product Owner | | | |
