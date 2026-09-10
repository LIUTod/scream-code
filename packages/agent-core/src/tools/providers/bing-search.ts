/**
 * BingSearchProvider — free web search via Bing's server-rendered HTML.
 *
 * GETs `bing.com/search?q=…` with browser-like headers and parses the
 * static results page (`<li class="b_algo">` blocks). Bing wraps outbound
 * links in a redirector (`bing.com/ck/a?…&u=a1<base64url>…`); the resolver
 * decodes the base64url payload back into the target URL.
 *
 * Hard failures (network error, non-2xx, anti-bot challenge page) THROW so a
 * FallbackSearchProvider can record the reason and try the next provider.
 * An empty array means the search ran fine but matched nothing.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import { withHardTimeout } from './search-timeout';

// ── Options ────────────────────────────────────────────────────────────

export interface BingSearchProviderOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// ── Request ─────────────────────────────────────────────────────────────

const BING_SEARCH_URL = 'https://www.bing.com/search';

/** Browser-like UA so Bing serves the standard server-rendered page. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ── Implementation ─────────────────────────────────────────────────────

export class BingSearchProvider implements WebSearchProvider {
  readonly name = 'bing';
  private readonly fetchImpl: typeof fetch;

  constructor(options: BingSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const limit = options?.limit ?? 5;

    const params = new URLSearchParams({ q: query });
    // Ask for a little headroom so filtering duplicates still leaves `limit`.
    params.set('count', String(Math.min(Math.max(limit + 5, 10), 30)));

    const response = await this.fetchImpl(`${BING_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en,en-US;q=0.9',
        Referer: 'https://www.bing.com/',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': BROWSER_USER_AGENT,
      },
      signal: withHardTimeout(options?.signal),
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Bing request failed: HTTP ${String(response.status)}`);
    }
    if (isChallengeResponse(html)) {
      throw new Error(
        'Bing blocked the request with an anti-bot challenge (shared-egress IPs are flagged more often)',
      );
    }

    return parseBingResults(html).slice(0, limit);
  }
}

// ── Bot-detection ────────────────────────────────────────────────────────

/**
 * Bing answers suspected automation with a challenge interstitial ("One last
 * step…", CAPTCHA or a JS-only gate) that contains no result blocks. The
 * presence of `b_algo` wins over keyword matching (some real result pages
 * embed the word "challenge").
 */
function isChallengeResponse(html: string): boolean {
  // Token-level match (a plain `includes('b_algo')` would be fooled by
  // template fragments like `b_algoSlug` on a challenge page).
  if (/\bclass="[^"]*\bb_algo\b[^"]*"/.test(html)) return false;
  return /one last step|captcha|verify (?:you are|it's) (?:a )?human|enable javascript|bm\.php/i.test(
    html,
  );
}

// ── HTML parsing ─────────────────────────────────────────────────────────

/**
 * Each organic result is an `<li class="b_algo">` whose `<h2><a href="…">`
 * carries the title link and whose `<p class="b_lineclamp…">` (class suffix
 * varies) carries the snippet. Answer boxes and ad rows lack that shape and
 * are dropped by the h2 match.
 */
const RESULT_BLOCK_START =
  '(?=<li\\b[^>]*\\bclass="[^"]*\\bb_algo\\b[^"]*"|<li\\b[^>]*\\bclass="[^"]*\\bb_ans\\b|<\\/ol>|$)';
const RESULT_BLOCK_RE = new RegExp(
  `<li\\b[^>]*\\bclass="[^"]*\\bb_algo\\b[^"]*"[^>]*>[\\s\\S]*?${RESULT_BLOCK_START}`,
  'g',
);
const RESULT_TITLE_RE = /<h2[^>]*>\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
const RESULT_SNIPPET_RE = /<p\b[^>]*\bclass="b_(?:lineclamp|paractl)[^"]*"[^>]*>([\s\S]*?)<\/p>/;

/** Strip markup and decode entities. Inline tags (Bing highlights query
 * terms in `<strong>`) are removed WITHOUT a space so punctuation stays
 * attached; block-ish tags collapse to a space so words do not fuse. */
function decodeHtmlText(value: string): string {
  return value
    .replaceAll(/<br\s*\/?\s*>/gi, ' ')
    .replaceAll(/<\/(?:p|div|li|h\d)>/gi, ' ')
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll(/&#(\d+);/g, (_, code: string) => {
      const cp = Number(code);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replaceAll(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const cp = Number.parseInt(code, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll(/&#39;|&apos;/gi, "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a Bing result href to the underlying target URL. Bing routes
 * outbound clicks through `bing.com/ck/a?…&u=a1<base64url>`; the `u=a1`
 * payload is base64url-encoded. Direct absolute URLs and protocol-relative
 * links are handled as-is.
 */
function unwrapBingUrl(href: string): string | undefined {
  if (href === '') return undefined;
  const decoded = href.replaceAll('&amp;', '&');
  const wrap = /[?&]u=a1([^&]+)/.exec(decoded);
  if (wrap?.[1] !== undefined) {
    const base64 = wrap[1].replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    try {
      const url = Buffer.from(padded, 'base64').toString('utf8');
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
    } catch {
      return undefined;
    }
    return undefined;
  }
  // A bing click-tracker we could not decode must be dropped, not surfaced:
  // returning it would hand the model a redirect URL that re-hits Bing's
  // anti-bot surface on the next fetch.
  if (/^https?:\/\/[^/]*\.?bing\.com\/ck\//i.test(decoded)) return undefined;
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  return undefined;
}

export function parseBingResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(RESULT_BLOCK_RE)) {
    const block = match[0];
    const title = RESULT_TITLE_RE.exec(block);
    if (title === null) continue;
    const url = unwrapBingUrl(title[1] ?? '');
    if (url === undefined || seen.has(url)) continue;
    const titleText = decodeHtmlText(title[2] ?? '');
    if (titleText === '') continue;
    seen.add(url);
    const snippet = RESULT_SNIPPET_RE.exec(block);
    const snippetText = snippet !== null ? decodeHtmlText(snippet[1] ?? '') : '';
    results.push({ title: titleText, url, snippet: snippetText !== '' ? snippetText : titleText });
  }
  return results;
}
