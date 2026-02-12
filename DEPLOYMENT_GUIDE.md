# Deployment Guide - Shopify Image Optimizer App

This guide walks you through deploying the Image Optimizer app to your local development environment and preparing it for production.

## Quick Start (Local Development)

### 1. Prerequisites Check

Ensure you have:
- ✅ Node.js 22.x or higher installed
- ✅ pnpm package manager installed
- ✅ Shopify Partner account created
- ✅ Development store set up
- ✅ Shopify CLI installed globally

### 2. Install Shopify CLI (if not already installed)

```bash
pnpm add -g @shopify/cli @shopify/app
```

### 3. Navigate to Project Directory

```bash
cd image-optimizer-app
```

### 4. Install Dependencies

```bash
pnpm install
```

If you see warnings about build scripts, approve them:
```bash
pnpm approve-builds
# Select all packages and approve
```

### 5. Rebuild Native Dependencies

```bash
pnpm rebuild
```

### 6. Set Up Database

```bash
npx prisma db push
npx prisma generate
```

This creates the SQLite database and generates the Prisma client.

### 7. Start Development Server

```bash
shopify app dev
```

**What happens:**
1. Shopify CLI authenticates you (if not already logged in)
2. Prompts you to select a Partner organization
3. Creates or selects an app in your Partner dashboard
4. Starts the Remix dev server
5. Creates a Cloudflare tunnel for HTTPS access
6. Opens your development store with the app installed

### 8. Access the App

The CLI will provide a URL like:
```
https://admin.shopify.com/store/your-store/apps/image-optimizer-app
```

Click it to open the app in your Shopify admin.

## Understanding the App Structure

### Key Files

- **`app/routes/app._index.tsx`** - Dashboard showing statistics
- **`app/routes/app.image-optimizer.tsx`** - Main optimization interface
- **`app/routes/app.settings.tsx`** - Configuration settings
- **`app/routes/api.webp-image.$imageId.tsx`** - API endpoint for themes
- **`prisma/schema.prisma`** - Database schema
- **`shopify.app.toml`** - App configuration and scopes

### Navigation Flow

```
Dashboard (/)
├── Image Optimizer (/image-optimizer)
│   └── Optimize All Images button
│       └── Batch processes all product images
└── Settings (/settings)
    └── Configure quality, dimensions, automation
```

## Making Changes

### Updating the Database Schema

1. Edit `prisma/schema.prisma`
2. Run `npx prisma db push` to apply changes
3. Run `npx prisma generate` to update the client

### Adding New Routes

1. Create a new file in `app/routes/`
2. Follow the naming convention:
   - `app.feature-name.tsx` for authenticated routes
   - `api.endpoint-name.tsx` for API routes
3. Add navigation link in `app/routes/app.tsx`

### Modifying Scopes

1. Edit `shopify.app.toml`
2. Update the `scopes` line
3. Restart `shopify app dev`
4. Reinstall the app in your dev store

## Testing the App

### 1. Create Test Products

In your development store:
1. Go to Products → Add product
2. Upload some test images (JPEG or PNG)
3. Save the product
4. Repeat for 5-10 products

### 2. Test Image Optimization

1. Open the app in Shopify admin
2. Navigate to "Image Optimizer"
3. Click "Optimize All Images"
4. Watch the progress and check the results table

### 3. Verify Optimization

Check the "Recent Optimizations" table for:
- ✅ Status shows "completed"
- ✅ Original size is larger than WebP size
- ✅ Savings percentage is displayed

### 4. Test API Endpoint

```bash
# Replace with your actual shop and image ID
curl "http://localhost:3000/api/webp-image/123456789?shop=your-store.myshopify.com"
```

## Packaging for Distribution

### Create Update Package

If you make changes and want to share them:

```bash
cd ~/image-optimizer-app
zip -r ~/image-optimizer-update.zip \
  app/routes/ \
  prisma/schema.prisma \
  shopify.app.toml \
  package.json \
  README_IMAGE_OPTIMIZER.md \
  DEPLOYMENT_GUIDE.md
```

### Installing Updates

To install updates from a zip file:

```bash
cd ~/Downloads/image-optimizer-app
unzip -o ~/Downloads/image-optimizer-update.zip -d .
pnpm install
npx prisma db push
npx prisma generate
shopify app dev
```

## Production Deployment

### Option 1: Shopify Hosting (Recommended)

```bash
shopify app deploy
```

This deploys your app to Shopify's infrastructure.

### Option 2: Self-Hosting

#### Requirements
- PostgreSQL database
- Node.js hosting (Heroku, Railway, Render, etc.)
- Environment variables configured

#### Steps

1. **Update Database Configuration**

Edit `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

2. **Set Environment Variables**

```bash
DATABASE_URL=postgresql://user:password@host:5432/dbname
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SCOPES=read_products,write_products,write_files,read_files
HOST=https://your-app-domain.com
```

3. **Run Migrations**

```bash
npx prisma migrate deploy
npx prisma generate
```

4. **Build for Production**

```bash
pnpm run build
```

5. **Start Production Server**

```bash
pnpm run start
```

### Production Considerations

⚠️ **Important**: The current implementation stores WebP images as base64 data URLs. For production, you should:

1. **Upload to Shopify Files API**
   - Use the Files API to upload optimized images
   - Store file URLs instead of data URLs

2. **Use External CDN**
   - Upload to AWS S3, Cloudflare R2, or similar
   - Serve images from CDN for better performance

3. **Implement Job Queue**
   - Use Bull or BullMQ for background processing
   - Prevent timeouts on large image batches

4. **Add Webhooks**
   - Listen for `products/create` and `products/update`
   - Auto-optimize new images

5. **Monitoring & Logging**
   - Add error tracking (Sentry, Bugsnag)
   - Monitor performance metrics
   - Log optimization jobs

## Troubleshooting

### App won't start

**Error**: `shopify: command not found`
```bash
pnpm add -g @shopify/cli @shopify/app
```

**Error**: `Prisma Client validation error`
```bash
npx prisma generate
```

**Error**: `Sharp installation failed`
```bash
pnpm rebuild sharp
```

### Database issues

**Error**: `Table does not exist`
```bash
npx prisma db push --force-reset
npx prisma generate
```

**Error**: `Migration failed`
```bash
# Delete the database and start fresh
rm prisma/dev.sqlite
npx prisma db push
npx prisma generate
```

### Authentication issues

**Error**: `Failed to authenticate`
```bash
shopify auth logout
shopify app dev
# Follow the authentication prompts
```

### Tunnel issues

**Error**: `530 error` or `X-Frame-Options`
```bash
# Stop the server (Ctrl+C)
shopify app dev
# This recreates the Cloudflare tunnel
```

## Development Workflow

### Daily Development

1. Start the dev server:
   ```bash
   shopify app dev
   ```

2. Make changes to files in `app/routes/`

3. Changes auto-reload in the browser

4. Check terminal for errors (not browser console)

### Adding Features

1. Plan the feature (UI, database, API)
2. Update Prisma schema if needed
3. Create/modify route files
4. Test in development store
5. Package and document

### Before Committing

```bash
# Format code
pnpm run format

# Lint code
pnpm run lint

# Type check
pnpm run typecheck
```

## Next Steps

After successful deployment:

1. ✅ Test all features in your development store
2. ✅ Review the README_IMAGE_OPTIMIZER.md for usage details
3. ✅ Configure settings in the app
4. ✅ Optimize your product images
5. ✅ Integrate the API with your theme (optional)
6. ✅ Monitor performance improvements

## Getting Help

- **Shopify CLI**: `shopify help`
- **Remix Docs**: https://remix.run/docs
- **Shopify App Docs**: https://shopify.dev/docs/apps
- **Prisma Docs**: https://www.prisma.io/docs
- **Sharp Docs**: https://sharp.pixelplumbing.com/

## Checklist

Before considering deployment complete:

- [ ] App installs successfully
- [ ] All pages load without errors
- [ ] Database schema is applied
- [ ] Image optimization works
- [ ] Statistics display correctly
- [ ] Settings save properly
- [ ] API endpoint responds
- [ ] Navigation works
- [ ] No console errors
- [ ] Documentation reviewed

---

**Ready to optimize your images!** 🚀
