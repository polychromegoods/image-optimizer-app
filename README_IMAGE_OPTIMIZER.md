# Shopify Image Optimizer App

A Shopify embedded app that converts product and variant images to WebP format for improved frontend performance while preserving original images on the backend.

## Features

- **WebP Conversion**: Automatically converts product images to WebP format with configurable quality settings
- **Performance Optimization**: Reduces image file sizes by 30-80% while maintaining visual quality
- **Original Preservation**: Keeps original images intact in Shopify admin for compatibility
- **Batch Processing**: Optimize all product images at once with a single click
- **Progress Tracking**: Monitor optimization status and savings in real-time
- **API Endpoint**: Provides API access for theme integration
- **Configurable Settings**: Adjust quality, dimensions, and automation preferences

## Architecture

### Technology Stack

- **Framework**: React Router v7 (Remix) + Vite
- **UI**: Shopify Polaris components
- **Database**: Prisma ORM with SQLite (dev) / PostgreSQL (production)
- **Image Processing**: Sharp library for high-performance image conversion
- **API**: Shopify GraphQL Admin API
- **Auth**: Shopify App Bridge with session tokens

### Database Schema

The app uses a single `ImageOptimization` model to track optimized images:

```prisma
model ImageOptimization {
  id              String   @id @default(uuid())
  shop            String
  productId       String
  imageId         String
  originalUrl     String
  webpUrl         String?
  status          String   @default("pending")
  fileSize        Int?
  webpFileSize    Int?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([shop, imageId])
  @@index([shop, status])
}
```

## Installation & Setup

### Prerequisites

- Node.js 22.x or higher
- pnpm package manager
- Shopify Partner account
- Shopify development store

### Step 1: Install Dependencies

```bash
cd image-optimizer-app
pnpm install
```

### Step 2: Set Up Database

```bash
npx prisma db push
npx prisma generate
```

### Step 3: Configure Shopify App

1. Create a new app in your Shopify Partner dashboard
2. Copy the `.env.example` to `.env` and fill in your credentials:

```bash
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SCOPES=read_products,write_products,write_files,read_files
```

### Step 4: Start Development Server

```bash
shopify app dev
```

This will:
- Start the Remix development server
- Create a Cloudflare tunnel for local development
- Open your development store with the app installed

## Usage

### Admin Interface

1. **Dashboard** (`/app`): View optimization statistics and recent activity
2. **Image Optimizer** (`/app/image-optimizer`): Manage image optimization
   - Click "Optimize All Images" to start batch processing
   - View progress and savings in real-time
   - See detailed optimization history
3. **Settings** (`/app/settings`): Configure optimization preferences
   - Adjust WebP quality (60-95)
   - Set maximum dimensions
   - Enable/disable auto-optimization
   - Toggle metadata preservation

### API Integration

The app provides an API endpoint to fetch WebP image URLs for theme integration:

```
GET /api/webp-image/:imageId?shop=yourstore.myshopify.com
```

**Response:**
```json
{
  "imageId": "gid://shopify/ProductImage/123456789",
  "originalUrl": "https://cdn.shopify.com/...",
  "webpUrl": "data:image/webp;base64,...",
  "fileSize": 245678,
  "webpFileSize": 89012,
  "savings": 63.7
}
```

### Theme Integration

Use the provided Liquid snippet in your theme:

```liquid
{% render 'webp-image', image: product.featured_image, alt: product.title %}
```

The snippet is located at `extensions/image-optimizer-theme/snippets/webp-image.liquid`

## How It Works

### Image Optimization Process

1. **Fetch Products**: App queries Shopify GraphQL API for products with images
2. **Download Images**: Original images are downloaded from Shopify CDN
3. **Convert to WebP**: Sharp library converts images to WebP format with specified quality
4. **Store Results**: Optimized images and metadata are stored in the database
5. **Serve via API**: Theme can request WebP URLs through the API endpoint

### WebP Benefits

- **Smaller File Sizes**: 25-35% smaller than JPEG, 26% smaller than PNG
- **Faster Loading**: Reduced bandwidth usage and improved page load times
- **Better SEO**: Google prioritizes fast-loading pages in search rankings
- **Modern Browser Support**: Supported by 95%+ of browsers (with fallback for older browsers)

## Configuration

### Quality Settings

- **Low (60)**: Maximum compression, noticeable quality loss
- **Medium (75)**: Good balance of size and quality
- **High (85)**: Recommended - minimal quality loss with good compression
- **Very High (95)**: Near-lossless, larger file sizes

### Dimension Limits

Set maximum width and height to prevent serving oversized images:
- Default: 2048x2048 pixels
- Recommended: Match your theme's largest image display size

### Auto-Optimization

Enable to automatically optimize new product images when uploaded (requires webhook setup).

## Production Deployment

### Important Notes

⚠️ **Current Implementation**: This demo version stores WebP images as base64 data URLs in the database. This is suitable for demonstration but **not recommended for production**.

### Production Recommendations

1. **Upload to Shopify Files API**: Use the Files API to upload optimized images
2. **Use CDN**: Store optimized images on a CDN (Cloudflare, AWS S3, etc.)
3. **Implement Webhooks**: Set up product webhooks for auto-optimization
4. **Use PostgreSQL**: Switch from SQLite to PostgreSQL for production database
5. **Add Job Queue**: Use a job queue (Bull, BullMQ) for background processing
6. **Implement Caching**: Cache API responses to reduce database queries

### Database Migration

For production, update `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Then run:
```bash
npx prisma migrate dev --name init
npx prisma generate
```

## File Structure

```
image-optimizer-app/
├── app/
│   ├── routes/
│   │   ├── app._index.tsx          # Dashboard
│   │   ├── app.image-optimizer.tsx # Main optimization UI
│   │   ├── app.settings.tsx        # Settings page
│   │   ├── app.tsx                 # Layout with navigation
│   │   └── api.webp-image.$imageId.tsx # API endpoint
│   ├── db.server.ts                # Database client
│   └── shopify.server.ts           # Shopify app configuration
├── extensions/
│   └── image-optimizer-theme/
│       └── snippets/
│           └── webp-image.liquid   # Theme snippet
├── prisma/
│   └── schema.prisma               # Database schema
├── shopify.app.toml                # App configuration
└── package.json                    # Dependencies
```

## Troubleshooting

### Common Issues

**Issue**: `Unknown argument refreshToken` error
- **Solution**: Ensure Prisma schema includes all required Session fields

**Issue**: Images not optimizing
- **Solution**: Check app permissions include `read_products,write_products,write_files,read_files`

**Issue**: Sharp installation fails
- **Solution**: Run `pnpm rebuild sharp` to compile native bindings

**Issue**: 530 error in browser
- **Solution**: Restart `shopify app dev` to recreate Cloudflare tunnel

## Performance Considerations

### Optimization Tips

1. **Batch Size**: Process images in batches of 50-100 to avoid timeouts
2. **Quality vs Size**: Use 85% quality for best balance
3. **Lazy Loading**: Always use `loading="lazy"` on images
4. **Responsive Images**: Generate multiple sizes for different viewports
5. **Cache Headers**: Set appropriate cache headers for optimized images

### Expected Results

- **JPEG to WebP**: 25-35% size reduction
- **PNG to WebP**: 26-50% size reduction
- **Page Load Time**: 15-30% improvement
- **Lighthouse Score**: +5-15 points on performance

## API Reference

### GraphQL Queries

**Get Products with Images:**
```graphql
query getProducts($first: Int!) {
  products(first: $first) {
    edges {
      node {
        id
        title
        images(first: 10) {
          edges {
            node {
              id
              url
              altText
            }
          }
        }
      }
    }
  }
}
```

### REST Endpoints

- `GET /api/webp-image/:imageId` - Get WebP URL for an image

## Future Enhancements

- [ ] Automatic optimization via product webhooks
- [ ] Support for AVIF format
- [ ] Bulk export of optimized images
- [ ] Integration with Shopify Files API
- [ ] Progressive image loading
- [ ] Image CDN integration
- [ ] Analytics and reporting dashboard
- [ ] A/B testing for quality settings

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review Shopify app development docs
3. Check Remix documentation
4. Review Sharp library docs

## License

This app is provided as-is for demonstration purposes.

## Credits

Built with:
- [Shopify App Remix Template](https://github.com/Shopify/shopify-app-template-remix)
- [Sharp](https://sharp.pixelplumbing.com/) - High-performance image processing
- [Polaris](https://polaris.shopify.com/) - Shopify's design system
