# Quick Start Guide - Image Optimizer App

Get your Shopify Image Optimizer app running in 5 minutes!

## Prerequisites

- Node.js 22.x or higher
- pnpm package manager
- Shopify Partner account
- Development store

## Installation Steps

### 1. Extract the App

```bash
unzip image-optimizer-app.zip
cd image-optimizer-app
```

### 2. Install Dependencies

```bash
pnpm install
```

If prompted about build scripts:
```bash
pnpm approve-builds
# Select all and approve
```

### 3. Rebuild Native Dependencies

```bash
pnpm rebuild
```

### 4. Set Up Database

```bash
npx prisma db push
npx prisma generate
```

### 5. Start Development Server

```bash
shopify app dev
```

**First time?** You'll be prompted to:
1. Log in to your Shopify Partner account
2. Select your organization
3. Create or select an app
4. Choose your development store

### 6. Access the App

The CLI will open your browser automatically. If not, look for a URL like:
```
https://admin.shopify.com/store/your-store/apps/image-optimizer-app
```

## Using the App

### Dashboard
- View optimization statistics
- See total savings
- Quick access to features

### Image Optimizer
1. Click "Image Optimizer" in the navigation
2. Click "Optimize All Images"
3. Watch the progress bar
4. Review results in the table

### Settings
- Adjust WebP quality (recommended: 85)
- Set maximum dimensions
- Configure auto-optimization

## What It Does

✅ Converts product images to WebP format  
✅ Reduces file sizes by 30-80%  
✅ Preserves original images  
✅ Tracks optimization progress  
✅ Provides API for theme integration  

## Next Steps

1. **Test with Sample Products**
   - Create 5-10 test products with images
   - Run the optimizer
   - Check the savings

2. **Configure Settings**
   - Adjust quality based on your needs
   - Set appropriate max dimensions

3. **Review Documentation**
   - `README_IMAGE_OPTIMIZER.md` - Full feature documentation
   - `DEPLOYMENT_GUIDE.md` - Detailed deployment instructions
   - `PRODUCTION_ENHANCEMENTS.md` - Production upgrade guide

## Troubleshooting

**App won't start?**
```bash
pnpm add -g @shopify/cli @shopify/app
```

**Database errors?**
```bash
npx prisma db push --force-reset
npx prisma generate
```

**Sharp errors?**
```bash
pnpm rebuild sharp
```

## Important Notes

⚠️ **Demo Version**: This version stores WebP images as data URLs. For production, see `PRODUCTION_ENHANCEMENTS.md` for CDN integration.

✅ **Safe to Use**: Original images are never modified. They remain in your Shopify admin unchanged.

## Support

- Check `DEPLOYMENT_GUIDE.md` for detailed troubleshooting
- Review Shopify app docs: https://shopify.dev/docs/apps
- Remix documentation: https://remix.run/docs

---

**Ready to optimize!** 🚀

Your images will load faster, your customers will be happier, and your SEO will improve!
