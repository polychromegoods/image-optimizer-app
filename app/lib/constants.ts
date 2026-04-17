// ─── Configuration ─────────────────────────────────────────────────────────────

/** WebP quality setting (0-100). 85 provides a good balance of quality and size. */
export const WEBP_QUALITY = 85;

/** Maximum number of products to fetch per GraphQL page. */
export const PRODUCTS_PER_PAGE = 250;

/** Maximum number of media items to fetch per product. */
export const MAX_MEDIA_PER_PRODUCT = 50;

/** Number of recent optimization records to display in the UI. */
export const RECENT_OPTIMIZATIONS_LIMIT = 50;

/** Polling interval in milliseconds for live progress updates. */
export const POLLING_INTERVAL_MS = 2000;

// ─── GraphQL Queries ───────────────────────────────────────────────────────────

export const QUERY_PRODUCTS_WITH_MEDIA = `#graphql
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          handle
          vendor
          productType
          media(first: ${MAX_MEDIA_PER_PRODUCT}) {
            edges {
              node {
                ... on MediaImage {
                  id
                  image { url altText width height }
                  mediaContentType
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const QUERY_SHOP_NAME = `#graphql
  query { shop { name } }
`;

// ─── GraphQL Mutations ─────────────────────────────────────────────────────────

export const MUTATION_STAGED_UPLOADS_CREATE = `#graphql
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

export const MUTATION_FILE_CREATE = `#graphql
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        ... on MediaImage { id image { url } }
        ... on GenericFile { id url }
      }
      userErrors { field message }
    }
  }
`;

export const MUTATION_PRODUCT_DELETE_MEDIA = `#graphql
  mutation productDeleteMedia($mediaIds: [ID!]!, $productId: ID!) {
    productDeleteMedia(mediaIds: $mediaIds, productId: $productId) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

export const MUTATION_PRODUCT_CREATE_MEDIA = `#graphql
  mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
    productCreateMedia(media: $media, productId: $productId) {
      media {
        ... on MediaImage { id image { url } }
      }
      mediaUserErrors { field message }
    }
  }
`;

export const MUTATION_PRODUCT_UPDATE_MEDIA = `#graphql
  mutation productUpdateMedia($media: [UpdateMediaInput!]!, $productId: ID!) {
    productUpdateMedia(media: $media, productId: $productId) {
      media {
        ... on MediaImage {
          id
          image { altText }
        }
      }
      mediaUserErrors { field message }
    }
  }
`;

// ─── Position & Variant Preservation Mutations ────────────────────────────────

/**
 * Query to get a product's media order (position) and variant-media associations.
 * Media is returned in position order by default.
 * Variants include their associated media IDs.
 */
export const QUERY_PRODUCT_MEDIA_DETAILS = `#graphql
  query getProductMediaDetails($productId: ID!) {
    product(id: $productId) {
      id
      media(first: ${MAX_MEDIA_PER_PRODUCT}) {
        edges {
          node {
            ... on MediaImage {
              id
              mediaContentType
            }
          }
        }
      }
      variants(first: 100) {
        edges {
          node {
            id
            media(first: 10) {
              edges {
                node {
                  ... on MediaImage {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Reorder media on a product. Moves is an array of { id, newPosition }.
 * newPosition is zero-based.
 */
export const MUTATION_PRODUCT_REORDER_MEDIA = `#graphql
  mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) {
      job { id }
      mediaUserErrors { field message }
    }
  }
`;

/**
 * Append (associate) media to specific variants of a product.
 */
export const MUTATION_VARIANT_APPEND_MEDIA = `#graphql
  mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      product { id }
      userErrors { field message }
    }
  }
`;

/**
 * Detach media from specific variants of a product.
 */
export const MUTATION_VARIANT_DETACH_MEDIA = `#graphql
  mutation productVariantDetachMedia($productId: ID!, $variantMedia: [ProductVariantDetachMediaInput!]!) {
    productVariantDetachMedia(productId: $productId, variantMedia: $variantMedia) {
      product { id }
      userErrors { field message }
    }
  }
`;
