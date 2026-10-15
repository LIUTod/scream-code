/**
 * GoogleSearchProvider — free web search via Google's server-rendered HTML.
 *
 * GETs `google.com/search?q=…` with browser-like headers and parses the
 * static results page. Organic results render the title link as an
 * `<a href="…">` wrapping an `<h3>` (or the `h3` wrapping the anchor, across
 * markup variants), with the snippet in a`VwiC3b`-style block. Google routes
 * some links through a self-redirect (`google.com/url?q=…`); the resolver
 * unwraps it and drops self-referential/ad hosts.
 *
 * Hard failures (network error, non-2xx, consent interstitial, CAPTCHA page)
 * THROW so a FallbackSearchProvider can record the reason and try the next
 * provider. An empty array means the search ran fine but matched nothing.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import { withHardTimeout } from './search-timeout';

// ── Options ────────────────────────────────────────────────────────────

export interface GoogleSearchProviderOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// ── Request ─────────────────────────────────────────────────────────────

const GOOGLE_SEARCH_URL = 'https://www.google.com/search';

/** Browser-like UA so Google serves the standard server-rendered page. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// ── Implementation ─────────────────────────────────────────────────────

export class GoogleSearchProvider implements WebSearchProvider {
  readonly name = 'google';
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const limit = options?.limit ?? 5;

    const params = new URLSearchParams({ q: query });
    // Ask for a little headroom so dropping self-referential links still
    // leaves `limit`.
    params.set('num', String(Math.min(Math.max(limit + 5, 10), 20)));

    const response = await this.fetchImpl(`${GOOGLE_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en,en-US;q=0.9',
        Referer: 'https://www.google.com/',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': BROWSER_USER_AGENT,
      },
      signal: withHardTimeout(options?.signal),
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Google request failed: HTTP ${String(response.status)}`);
    }
    if (isChallengeResponse(html)) {
      throw new Error(
        'Google blocked the request with a CAPTCHA/consent interstitial',
      );
    }

    return parseGoogleResults(html).slice(0, limit);
  }
}

// ── Bot-detection ────────────────────────────────────────────────────────

/**
 * Google answers suspected automation with a `/sorry/` CAPTCHA page, an
 * "unusual traffic" wall, or a consent interstitial ("Before you continue
 * to…") — none of which carry organic `<h3>` result links.
 */
function isChallengeResponse(html: string): boolean {
  return /https?:\/\/(?:www\.)?google\.[a-z.]+\/sorry\/|g-recaptcha|recaptcha|unusual traffic|before you continue to|enable javascript|consent\.google\./i.test(
    html,
  );
}

// ── HTML parsing ─────────────────────────────────────────────────────────

/**
 * An organic result anchors its `<h3>` title inside the link (`<a href>` →
 * `<h3>`), or wraps the link inside the heading on some variants. Knowledge
 * panels, ad rows and related-question carousels do not pair an external
 * `href` with an `<h3>` and are dropped.
 */
const TITLE_BLOCK_RE = /<h3\b[^>]*>([\s\S]*?)<\/h3>/g;
const WRAPPING_ANCHOR_RE = /<a\b[^>]*\bhref="([^"]+)"[^>]*>\s*$/;
const INNER_ANCHOR_RE = /<a\b[^>]*\bhref="([^"]+)"/;
const SNIPPET_RE = /<div\b[^>]*\bclass="[^"]*\b(?:VwiC3b|IsZVec|hgKEbd|aCOpRe)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/;

/** Hosts that are navigation/ad surface rather than organic results. */
const SELF_OR_AD_HOST_RE =
  /https?:\/\/(?:[^/]*\.)?(?:googleadservices\.com|googlesyndication\.com|doubleclick\.net|gstatic\.com)\//i;

const SELF_NAVIGATING_PATH_RE =
  /https?:\/\/(?:[^/]*\.)?google(?:adservices|\.[a-z.]+)*\.[a-z.]+\/(?:url|aclk|imgres|search|apps-activity|shop(?:ping)?|images)\b/i;

/** Strip markup and decode entities. Inline tags (Google highlights query
 * terms in `<em>`/`<b>`) are removed WITHOUT a space so punctuation stays
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
 * Resolve a Google result href to the underlying target URL. Google routes
 * some organic clicks through `/url?q=<target>&…`; direct absolute URLs and
 * protocol-relative links are handled as-is. The redirect check runs BEFORE
 * the self-navigating filter, since the wrapper URL is self-referential by
 * design while its target is the actual result.
 */
const REDIRECT_HOST_RE = /^https?:\/\/[^/]*\bgoogle[a-z.]*\.[a-z.]+\/url\b/i;
const REDIRECT_TARGET_RE = /[?&]q=([^&]+)/;

function unwrapGoogleUrl(href: string): string | undefined {
  if (href === '') return undefined;
  const decoded = href.replaceAll('&amp;', '&');

  if (SELF_OR_AD_HOST_RE.test(decoded)) return undefined;

  if (REDIRECT_HOST_RE.test(decoded)) {
    const wrapped = REDIRECT_TARGET_RE.exec(decoded)?.[1];
    if (wrapped === undefined) return undefined;
    try {
      const url = decodeURIComponent(wrapped).trim();
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
    } catch {
      return undefined;
    }
    return undefined;
  }

  if (SELF_NAVIGATING_PATH_RE.test(decoded)) return undefined;
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  return undefined;
}

export function parseGoogleResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(TITLE_BLOCK_RE)) {
    const headingStart = match.index ?? 0;
    const headingEnd = headingStart + match[0].length;
    const inner = match[1] ?? '';

    // Preferred shape: the organic anchor wraps the whole heading, so the
    // href sits directly before it. Fallback: a newer variant nests the
    // anchor inside the heading.
    let href: string | undefined =
      WRAPPING_ANCHOR_RE.exec(html.slice(Math.max(0, headingStart - 400), headingStart))?.[1];
    href ??= INNER_ANCHOR_RE.exec(inner)?.[1];
    if (href === undefined) continue;

    const url = unwrapGoogleUrl(href);
    if (url === undefined || seen.has(url)) continue;

    const titleText = decodeHtmlText(inner);
    if (titleText === '') continue;

    seen.add(url);
    const snippet = SNIPPET_RE.exec(html.slice(headingEnd, headingEnd + 1400));
    const snippetText = snippet !== null ? decodeHtmlText(snippet[1] ?? '') : '';
    results.push({ title: titleText, url, snippet: snippetText !== '' ? snippetText : titleText });
  }
  return results;
}
