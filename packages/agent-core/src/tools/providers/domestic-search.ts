/**
 * Domestic (China-reachable) HTML search providers — Sogou, 360, Baidu.
 *
 * These are the tail of the web-search fallback chain: when DuckDuckGo is
 * unreachable or bot-blocked (always the case for direct connections from
 * mainland China), these engines still answer over plain HTTPS without any
 * API key. Each POSTs/GETs a server-rendered results page with browser-like
 * headers and parses the result blocks.
 *
 * Same contract as DuckDuckGoSearchProvider: hard failures (network error,
 * non-2xx, anti-bot page) THROW so the FallbackSearchProvider records the
 * reason and advances; an empty array means the search ran but matched
 * nothing. Result URLs may be redirect wrappers (baidu.com/link?url=…,
 * so.com/link?m=…) — they resolve fine when opened and unwrapping them
 * would cost one extra request per result.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import { withHardTimeout } from './search-timeout';

export interface DomesticSearchProviderOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

type SearchOptions = { limit?: number; includeContent?: boolean; toolCallId?: string; signal?: AbortSignal };

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'User-Agent': BROWSER_USER_AGENT,
};

// ── Shared helpers ───────────────────────────────────────────────────────

/** Strip inline tags and decode the common named/numeric entities. */
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

interface EngineSpec {
  /** Human-facing engine name used in error messages. */
  readonly label: string;
  /** Build the result-page URL for a query. */
  readonly url: (query: string) => string;
  /** Split the page into per-result HTML blocks. */
  readonly blockRe: RegExp;
  /** Extract [href, titleHtml] from a block. */
  readonly titleRe: RegExp;
  /** Extract snippet HTML from a block (best effort). */
  readonly snippetRe?: RegExp;
  /** Normalise an extracted href (resolve relative links, drop junk). */
  readonly normalizeUrl?: (href: string) => string | undefined;
  /** Body markers of the engine's anti-bot page. */
  readonly botMarkers: readonly string[];
}

async function searchEngine(
  spec: EngineSpec,
  fetchImpl: typeof fetch,
  query: string,
  options: SearchOptions | undefined,
): Promise<WebSearchResult[]> {
  const limit = options?.limit ?? 5;
  const response = await fetchImpl(spec.url(query), {
    headers: BROWSER_HEADERS,
    signal: withHardTimeout(options?.signal),
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`${spec.label} request failed: HTTP ${String(response.status)}`);
  }
  if (spec.botMarkers.some((m) => html.includes(m))) {
    throw new Error(`${spec.label} blocked the request with an anti-bot challenge`);
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(spec.blockRe)) {
    if (results.length >= limit) break;
    const block = match[1] ?? '';
    const title = spec.titleRe.exec(block);
    if (title === null) continue;
    const rawHref = (title[1] ?? '').replace(/&amp;/gi, '&');
    const url = spec.normalizeUrl !== undefined ? spec.normalizeUrl(rawHref) : rawHref;
    if (url === undefined || url === '' || seen.has(url)) continue;
    const titleText = decodeHtmlText(title[2] ?? '');
    if (titleText === '') continue;
    seen.add(url);
    const snippetMatch = spec.snippetRe?.exec(block);
    const snippetText = snippetMatch != null ? decodeHtmlText(snippetMatch[1] ?? '') : '';
    results.push({ title: titleText, url, snippet: snippetText !== '' ? snippetText : titleText });
  }
  return results;
}

// ── Sogou ────────────────────────────────────────────────────────────────

const SOGOU: EngineSpec = {
  label: 'Sogou',
  url: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
  blockRe: /<div\b[^>]*\bclass="[^"]*\b(?:vrwrap|rb)\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\b(?:vrwrap|rb)\b|$)/g,
  titleRe: /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
  snippetRe: /<(?:p|div)\b[^>]*\bclass="[^"]*\b(?:str-text|str_info|text-layout)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/,
  normalizeUrl: (href) => {
    if (href.startsWith('/link?')) return `https://www.sogou.com${href}`;
    // Internal navigation/related-query links are not results.
    if (href.includes('sogou.com/sogou?')) return undefined;
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    return undefined;
  },
  botMarkers: ['antispider', '异常访问请求'],
};

export class SogouSearchProvider implements WebSearchProvider {
  readonly name = 'sogou';
  private readonly fetchImpl: typeof fetch;

  constructor(options: DomesticSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  search(query: string, options?: SearchOptions): Promise<WebSearchResult[]> {
    return searchEngine(SOGOU, this.fetchImpl, query, options);
  }
}

// ── 360 (so.com) ─────────────────────────────────────────────────────────

const SO360: EngineSpec = {
  label: '360 Search',
  url: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
  blockRe: /<li\b[^>]*\bclass="[^"]*\bres-list\b[^"]*"[^>]*>([\s\S]*?)(?=<li\b[^>]*\bclass="[^"]*\bres-list\b|$)/g,
  titleRe: /<h3[^>]*class="[^"]*\bres-title\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
  snippetRe: /<p\b[^>]*\bclass="[^"]*\bres-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/,
  botMarkers: ['安全验证'],
};

export class So360SearchProvider implements WebSearchProvider {
  readonly name = '360';
  private readonly fetchImpl: typeof fetch;

  constructor(options: DomesticSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  search(query: string, options?: SearchOptions): Promise<WebSearchResult[]> {
    return searchEngine(SO360, this.fetchImpl, query, options);
  }
}

// ── Baidu ────────────────────────────────────────────────────────────────

const BAIDU: EngineSpec = {
  label: 'Baidu',
  url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  blockRe: /<div\b[^>]*\bclass="[^"]*\bc-container\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bc-container\b|$)/g,
  titleRe: /<h3[^>]*class="[^"]*\bt\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
  snippetRe: /<(?:span|div)\b[^>]*\bclass="[^"]*\b(?:c-abstract|content-right)[^"]*\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/,
  botMarkers: ['百度安全验证', 'wappass.baidu.com'],
};

export class BaiduSearchProvider implements WebSearchProvider {
  readonly name = 'baidu';
  private readonly fetchImpl: typeof fetch;

  constructor(options: DomesticSearchProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  search(query: string, options?: SearchOptions): Promise<WebSearchResult[]> {
    return searchEngine(BAIDU, this.fetchImpl, query, options);
  }
}
