import { DEFAULT_CATALOG_URL } from '@scream-cli/scream-code-sdk';

export interface ConnectCatalogRequest {
  readonly url: string;
  /** Hidden /config diy path — user manually enters provider details. */
  readonly diy: boolean;
}

/**
 * Resolve the catalog request for /config.
 * - /config      → remote-first catalog browser
 * - /config diy  → hidden manual provider setup (not shown in help)
 */
export function resolveConnectCatalogRequest(args: string): ConnectCatalogRequest {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === 'diy') {
    return { url: DEFAULT_CATALOG_URL, diy: true };
  }
  return { url: DEFAULT_CATALOG_URL, diy: false };
}
