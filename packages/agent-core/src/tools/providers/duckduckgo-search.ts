/**
 * DuckDuckGoSearchProvider — free web search via DuckDuckGo's no-JS HTML
 * frontend.
 *
 * POSTs `q=…` to `html.duckduckgo.com/html/` with browser-like headers and
 * parses the static results page. Two earlier approaches were dropped:
 *   - Instant Answer API (`api.duckduckgo.com`): only returns content for
 *     Wikipedia/Wolfram-Alpha-style topics — empty for the vast majority of
 *     agent queries (omp #3799).
 *   - Lite endpoint (`lite.duckduckgo.com`) with a bare request: high
 *     bot-detection rate without a browser User-Agent.
 *
 * Hard failures (network error, non-2xx, bot-detection page) THROW so a
 * FallbackSearchProvider can record the reason and try the next provider.
 * An empty array means the search ran fine but matched nothing.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import { withHardTimeout } from './search-timeout';

// ── Options ────────────────────────────────────────────────────────────

export interface DuckDuckGoSearchProviderOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// ── Request ─────────────────────────────────────────────────────────────

const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';

/**
 * Browser-like UA so DDG serves the standard results page instead of the
 * mobile/noscript variants, and is less likely to trip bot detection.
 * DDG answers automation it suspects with HTTP 202 plus an anomaly modal;
 * the body check (not the status) is the reliable signal.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ── Implementation ─────────────────────────────────────────────────────

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly name = 'duckduckgo';
  private readonly fetchImpl: typeof fetch;

  constructor(options: DuckDuckGoSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const limit = options?.limit ?? 5;

    const form = new URLSearchParams({ q: query, kl: 'us-en' });
    // Match the real browser form submission (omp's template).
    form.set('b', '');

    const response = await this.fetchImpl(DUCKDUCKGO_HTML_URL, {
      method: 'POST',
      body: form.toString(),
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en,en-US;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://html.duckduckgo.com/',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': BROWSER_USER_AGENT,
      },
      signal: withHardTimeout(options?.signal),
    });

    const html = await response.text();
    if (!response.ok && response.status !== 202) {
      throw new Error(`DuckDuckGo request failed: HTTP ${String(response.status)}`);
    }
    if (isAnomalyResponse(html)) {
      throw new Error(
        'DuckDuckGo blocked the request with a bot-detection challenge (common from datacenter/shared-egress IPs)',
      );
    }

    return parseHtmlResults(html).slice(0, limit);
  }
}

// ── Bot-detection ────────────────────────────────────────────────────────

/** `true` when DDG returned the bot-challenge modal instead of results. */
function isAnomalyResponse(html: string): boolean {
  return html.includes('anomaly-modal') || html.includes('anomaly.js');
}

// ── HTML parsing ─────────────────────────────────────────────────────────

/**
 * Each result lives in a `<div class="result …">` container with
 * `<a class="result__a">` for the title link and an optional
 * `<a|div|span class="result__snippet">` sibling for the preview text.
 * Sponsored rows, missing snippets, and the pagination row are tolerated.
 */
const RESULT_BLOCK_RE =
  /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
const RESULT_TITLE_RE = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
const RESULT_SNIPPET_RE =
  /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;

/** Strip inline tags (DDG wraps query terms in `<b>`) and decode entities. */
function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a DDG result href to the underlying target URL. DDG routes
 * outbound clicks through `//duckduckgo.com/l/?uddg=<encoded>`; handles
 * redirect wrappers, protocol-relative links, and plain absolute URLs.
 */
function unwrapResultUrl(href: string): string | undefined {
  if (href === '') return undefined;
  const decoded = href.replace(/&amp;/gi, '&');
  const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
  if (wrapMatch?.[1] !== undefined) {
    try {
      return decodeURIComponent(wrapMatch[1]);
    } catch {
      return undefined;
    }
  }
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  return undefined;
}

function parseHtmlResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(RESULT_BLOCK_RE)) {
    const block = match[1] ?? '';
    const title = RESULT_TITLE_RE.exec(block);
    if (title === null) continue;
    const url = unwrapResultUrl(title[1] ?? '');
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
