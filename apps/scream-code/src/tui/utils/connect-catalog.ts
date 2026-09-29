import { DEFAULT_CATALOG_URL } from '@scream-code/scream-code-sdk';

export interface ConnectCatalogRequest {
  readonly url: string;
  /** Hidden /config diy path — user manually enters provider details. */
  readonly diy: boolean;
  /** Hidden /config image path — image-generation API setup (not shown in help). */
  readonly image: boolean;
}

/**
 * Resolve the catalog request for /config.
 * - /config        → remote-first catalog browser
 * - /config diy    → hidden manual provider setup (not shown in help)
 * - /config image  → hidden image-generation API setup (not shown in help)
 */
export function resolveConnectCatalogRequest(args: string): ConnectCatalogRequest {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === 'diy') {
    return { url: DEFAULT_CATALOG_URL, diy: true, image: false };
  }
  if (trimmed === 'image') {
    return { url: DEFAULT_CATALOG_URL, diy: false, image: true };
  }
  return { url: DEFAULT_CATALOG_URL, diy: false, image: false };
}
