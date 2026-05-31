/**
 * DuckDuckGoSearchProvider — free web search via DuckDuckGo.
 *
 * Uses two complementary DuckDuckGo data sources:
 *   1. Instant Answer API (`api.duckduckgo.com`) — always available, no auth,
 *      returns instant answers and related topics as structured JSON.
 *   2. Lite HTML page (`lite.duckduckgo.com`) — returns full web search
 *      results as minimal HTML; parsed via regex. May be CAPTCHA-blocked
 *      from datacenter IPs.
 *
 * The provider never throws — individual search methods return an empty
 * array on failure so that a FallbackSearchProvider can continue to the
 * next provider in the chain.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

// ── Options ────────────────────────────────────────────────────────────

export interface DuckDuckGoSearchProviderOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

// ── DuckDuckGo API shapes ───────────────────────────────────────────────

interface DuckDuckGoRelatedTopic {
  readonly FirstURL?: string;
  readonly Text?: string;
  readonly Name?: string;
  readonly Topics?: DuckDuckGoRelatedTopic[];
}

interface DuckDuckGoApiResponse {
  readonly Abstract?: string;
  readonly AbstractText?: string;
  readonly AbstractURL?: string;
  readonly AbstractSource?: string;
  readonly Heading?: string;
  readonly RelatedTopics?: DuckDuckGoRelatedTopic[];
}

// ── Implementation ─────────────────────────────────────────────────────

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(options: DuckDuckGoSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string },
  ): Promise<WebSearchResult[]> {
    const limit = options?.limit ?? 5;

    // 1. Try Instant Answer API first — always available, no auth, no CAPTCHA risk.
    let results = await this.searchViaApi(query, limit);

    // 2. If the API returned nothing useful, try scraping the Lite HTML page.
    if (results.length === 0) {
      results = await this.searchViaLite(query, limit);
    }

    return results;
  }

  // ── Instant Answer API ──────────────────────────────────────────────

  /**
   * Query the DuckDuckGo Instant Answer API.
   *
   * Returns up to `limit` results built from the abstract and flattened
   * RelatedTopics. Returns `[]` on any failure (network error, non-2xx,
   * parse failure) so callers can fall through to the next method.
   */
  private async searchViaApi(query: string, limit: number): Promise<WebSearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch {
      return [];
    }

    if (response.status !== 200) {
      await drainBody(response);
      return [];
    }

    let json: DuckDuckGoApiResponse;
    try {
      json = (await response.json()) as DuckDuckGoApiResponse;
    } catch {
      return [];
    }

    return this.buildApiResults(json, limit);
  }

  private buildApiResults(json: DuckDuckGoApiResponse, limit: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];

    // Abstract / instant answer — always first if present.
    if (json.AbstractText && json.AbstractURL && json.AbstractText.trim().length > 0) {
      results.push({
        title: json.Heading && json.Heading.trim().length > 0 ? json.Heading : json.AbstractSource ?? 'DuckDuckGo',
        url: json.AbstractURL,
        snippet: json.AbstractText,
      });
    }

    // Flatten RelatedTopics hierarchically.
    if (json.RelatedTopics && json.RelatedTopics.length > 0) {
      const flattened = flattenRelatedTopics(json.RelatedTopics);
      for (const topic of flattened) {
        if (results.length >= limit) break;
        const url = topic.FirstURL ?? '';
        const text = topic.Text ?? '';
        if (url === '' || text === '') continue;
        results.push({ title: text, url, snippet: text });
      }
    }

    return results.slice(0, limit);
  }

  // ── Lite HTML scraping ──────────────────────────────────────────────

  /**
   * Scrape DuckDuckGo Lite search results.
   *
   * Lite is a minimal HTML table with no JavaScript, designed for basic
   * browsers. It may return a CAPTCHA page from datacenter IPs — in that
   * case we return `[]` so the caller can fall through.
   */
  private async searchViaLite(query: string, limit: number): Promise<WebSearchResult[]> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch {
      return [];
    }

    if (response.status !== 200) {
      await drainBody(response);
      return [];
    }

    let html: string;
    try {
      html = await response.text();
    } catch {
      return [];
    }

    // Detect CAPTCHA / bot-detection page.
    if (isCaptchaPage(html)) return [];

    return parseLiteResults(html, limit);
  }
}

// ── RelatedTopics flattening ───────────────────────────────────────────

/**
 * Recursively flatten DuckDuckGo RelatedTopics.
 *
 * The API nests topics in two ways:
 *   - A direct topic has `FirstURL` + `Text` (may lack `Topics`).
 *   - A category group has a `Name` and nested `Topics[]`.
 * We walk both shapes, returning a flat list of leaf topics.
 */
function flattenRelatedTopics(
  topics: readonly DuckDuckGoRelatedTopic[],
): DuckDuckGoRelatedTopic[] {
  const out: DuckDuckGoRelatedTopic[] = [];
  for (const topic of topics) {
    if (topic.Topics && topic.Topics.length > 0) {
      // Category group — recurse into its topics.
      out.push(...flattenRelatedTopics(topic.Topics));
    } else if (topic.FirstURL) {
      // Direct topic entry.
      out.push(topic);
    }
  }
  return out;
}

// ── CAPTCHA detection ──────────────────────────────────────────────────

/**
 * Return true if the HTML looks like a DuckDuckGo bot-detection / CAPTCHA page.
 */
function isCaptchaPage(html: string): boolean {
  return (
    html.includes('anomaly-modal') ||
    html.includes('challenge-form') ||
    html.includes('g-recaptcha') ||
    html.includes('data-testid="anomaly-modal"')
  );
}

// ── Lite HTML parsing ──────────────────────────────────────────────────

/**
 * DuckDuckGo Lite result rows are inside `<tr>` blocks with a predictable
 * anchor shape. This regex extracts the `<a class="result-link"...>` block
 * and the following snippet text from the same row.
 *
 * The Lite markup is intentionally minimal (no JS, no CSS classes beyond a
 * handful of utility names), so a DOM parser is unnecessary overhead.
 */
const LITE_RESULT_RE =
  /<a\s[^>]*?\bclass\s*=\s*["'][^"']*result-link[^"']*["'][^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

const LITE_SNIPPET_RE =
  /<td\s[^>]*?\bclass\s*=\s*["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;

/** Strip HTML tags and decode common HTML entities. */
function stripHtmlAndDecode(text: string): string {
  const stripped = text.replace(/<[^>]*>/g, '');
  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Unwrap a DuckDuckGo redirect URL to the real target if possible. */
function unwrapDdgRedirect(url: string): string {
  // DDG wraps external links as //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
  const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch?.[1]) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch {
      return url;
    }
  }
  return url;
}

function parseLiteResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // Extract result-link `<a>` blocks.
  const linkMatches = html.matchAll(LITE_RESULT_RE);
  for (const match of linkMatches) {
    if (results.length >= limit) break;
    const href = unwrapDdgRedirect(match[1] ?? '');
    const title = stripHtmlAndDecode(match[2] ?? '');
    if (href === '' || title === '') continue;
    results.push({ title, url: href, snippet: title });
  }

  // Enrich with snippets from result-snippet `<td>` blocks if available.
  const snippetMatches = html.matchAll(LITE_SNIPPET_RE);
  let snippetIndex = 0;
  for (const match of snippetMatches) {
    if (snippetIndex >= results.length) break;
    const snippet = stripHtmlAndDecode(match[1] ?? '');
    const entry = results[snippetIndex];
    if (entry && snippet.length > 0) {
      entry.snippet = snippet;
    }
    snippetIndex++;
  }

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Drain a response body so the connection can be reused. */
async function drainBody(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // ignore
  }
}
