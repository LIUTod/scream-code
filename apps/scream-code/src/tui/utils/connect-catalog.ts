import { DEFAULT_CATALOG_URL } from '@scream-cli/scream-code-sdk';

const BARE_HTTP_URL_RE = /^https?:\/\/\S+$/;

export interface ConnectCatalogRequest {
  readonly url: string;
  readonly preferBuiltIn: boolean;
  readonly allowBuiltInFallback: boolean;
}

export type ConnectCatalogResolution =
  | { readonly kind: 'ok'; readonly request: ConnectCatalogRequest }
  | { readonly kind: 'error'; readonly message: string };

export function resolveConnectCatalogRequest(args: string): ConnectCatalogResolution {
  const trimmed = args.trim();

  if (trimmed === '') {
    return {
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: true,
        allowBuiltInFallback: true,
      },
    };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let explicitUrl: string | undefined;
  let refreshRequested = false;

  for (const token of tokens) {
    if (token.toLowerCase() === 'refresh') {
      refreshRequested = true;
      continue;
    }

    if (BARE_HTTP_URL_RE.test(token)) {
      if (explicitUrl !== undefined) {
        return {
          kind: 'error',
          message: `只能提供一个 catalog URL。收到 "${explicitUrl}" 和 "${token}"。`,
        };
      }
      explicitUrl = token;
      continue;
    }

    if (token.startsWith('--')) {
      return {
        kind: 'error',
        message: `意外的参数 "${token}"。请使用 /config [url] [refresh]。`,
      };
    }

    return {
      kind: 'error',
      message: `未知参数 "${token}"。用法: /config [url] [refresh]`,
    };
  }

  if (explicitUrl !== undefined) {
    return {
      kind: 'ok',
      request: {
        url: explicitUrl,
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    };
  }

  return {
    kind: 'ok',
    request: {
      url: DEFAULT_CATALOG_URL,
      preferBuiltIn: !refreshRequested,
      allowBuiltInFallback: true,
    },
  };
}
