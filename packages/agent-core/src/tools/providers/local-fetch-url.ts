/**
 * LocalFetchURLProvider — host-side URL fetcher.
 *
 * Flow:
 *   1. GET the URL with a Chrome-like UA.
 *   2. Reject HTTP >= 400 with the status code in the message.
 *   3. Reject responses larger than `maxBytes` (content-length first,
 *      then measured body length as a defensive second check).
 *   4. `text/plain` / `text/markdown` → passthrough verbatim.
 *   5. Otherwise (assumed HTML) → run Readability over a linkedom
 *      document. Return `# ${title}\n\n${text}` (title omitted when
 *      absent). If extraction yields no meaningful text, fall back to
 *      common content containers (`<article>` / `<main>` / `<body>`)
 *      before throwing a "meaningful content" error.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';
import { convertBufferWithMarkit } from '../../utils/markit';
import { FetchCache } from './fetch-cache';

/** Document types the markit engine converts to markdown. */
const CONVERTIBLE_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.epub']);
const CONVERTIBLE_MIME_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['application/pdf', '.pdf'],
  ['application/x-pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/epub+zip', '.epub'],
];

/**
 * Decide whether a response is a convertible document, from Content-Type
 * first and the URL path extension as fallback. `confident: true` means the
 * Content-Type itself declared a document type (conversion failure is a real
 * error); `confident: false` means only the URL extension matched (an HTML
 * page at a .pdf URL must fall back to normal extraction).
 */
function resolveDocumentExtension(
  url: string,
  contentType: string,
): { extension: string; confident: boolean } | undefined {
  for (const [prefix, extension] of CONVERTIBLE_MIME_PREFIXES) {
    if (contentType.startsWith(prefix)) return { extension, confident: true };
  }
  // The URL extension is only a guess — never override a declared text type
  // (an HTML viewer page at a .pdf URL is not a document).
  if (contentType.length > 0 && !contentType.startsWith('application/octet-stream') && !contentType.startsWith('binary/octet-stream')) {
    return undefined;
  }
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const dot = pathname.lastIndexOf('.');
    if (dot >= 0) {
      const extension = pathname.slice(dot);
      if (CONVERTIBLE_EXTENSIONS.has(extension)) return { extension, confident: false };
    }
  } catch {
    // Malformed URL — the fetch itself already succeeded, ignore.
  }
  return undefined;
}

/** Hard ceiling for one markit conversion (omp uses 20s; allow slow hosts). */
const CONVERSION_TIMEOUT_MS = 30_000;

export interface LocalFetchURLProviderOptions {
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytes?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly cache?: FetchCache;
  readonly dnsLookup?: (hostname: string) => Promise<string[]>;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// Hard ceiling per request — a server that accepts the connection and then
// stalls must not hang the tool call (and the whole agent turn) forever.
const FETCH_TIMEOUT_MS = 30_000;

// Readability's .d.ts references the global `Document` type, but this
// package compiles with `lib: ES2023` (no DOM). Extracting the
// constructor parameter type keeps us off the global `Document` name
// while still accepting whatever Readability wants.
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// linkedom's published types depend on DOM libs we don't load. Declare
// the minimal surface we actually use so the rest of the file stays
// type-safe without pulling lib.dom.d.ts into the host build.
interface DomElementLike {
  querySelector(selectors: string): { textContent: string | null } | null;
  textContent: string | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

/**
 * SSRF guard — reject non-http(s) schemes and (by default) any hostname
 * that is, or resolves to, a private / loopback / link-local / ULA IP.
 *
 * Two layers:
 *   1. Static check against the URL string (scheme, hostname patterns,
 *      IP literal ranges).
 *   2. DNS resolution of the hostname; if any resolved address is private,
 *      the request is blocked (prevents DNS-rebinding to internal IPs).
 *
 * A TOCTOU window remains between resolution and the actual fetch (the
 * DNS answer could change), but this is materially stronger than a pure
 * static check. Pinning the resolved IP through to the connection is
 * left for a follow-up.
 */
async function assertSafeFetchTarget(
  url: string,
  allowPrivate: boolean,
  dnsLookup: (hostname: string) => Promise<string[]>,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`);
  }
  if (allowPrivate) return;

  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }

  // If the hostname is an IP literal, check it directly — no DNS needed.
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
    return;
  }

  // Domain name — resolve and verify every address to block DNS rebinding.
  let addresses: string[];
  try {
    addresses = await dnsLookup(host);
  } catch {
    throw new Error(`DNS resolution failed for "${host}"`);
  }
  for (const address of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`Refusing to fetch "${host}" — resolves to private address ${address}`);
    }
  }
}

/**
 * Returns true for loopback, private, link-local, ULA, and other
 * non-routable IP addresses (both IPv4 and IPv6).
 */
function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — delegate to the embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped !== null) {
    return isPrivateIp(mapped[1]!);
  }

  // IPv4 dotted-quad.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4 !== null) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = octets as [number, number, number, number];
    // 127.0.0.0/8 loopback, 10.0.0.0/8, 192.168.0.0/16,
    // 172.16.0.0/12, 169.254.0.0/16 link-local / AWS metadata,
    // 0.0.0.0/8 "this network", 100.64.0.0/10 CGNAT.
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      a === 0 ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  // IPv6 loopback / unspecified / link-local / ULA.
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd')
  );
}

function cacheKey(url: string, allowPrivate: boolean, maxBytes: number, userAgent: string): string {
  return `local:${url}:${String(allowPrivate)}:${String(maxBytes)}:${userAgent}`;
}

const defaultDnsLookup = async (hostname: string): Promise<string[]> => {
  const result = await lookup(hostname, { all: true });
  return result.map((a) => a.address);
};

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;
  private readonly cache: FetchCache;
  private readonly dnsLookup: (hostname: string) => Promise<string[]>;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
    this.cache = options.cache ?? new FetchCache();
    this.dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  }

  async fetch(url: string, _options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    const key = cacheKey(url, this.allowPrivateAddresses, this.maxBytes, this.userAgent);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // SSRF check (including DNS resolution) only on cache miss — a cached
    // entry is a snapshot of content already fetched from a safe address.
    await assertSafeFetchTarget(url, this.allowPrivateAddresses, this.dnsLookup);

    const result = await this.fetchFresh(url);
    this.cache.set(key, result);
    return result;
  }

  private async fetchFresh(url: string): Promise<UrlFetchResult> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 400) {
      // Drain the unused body so undici can release the socket back to
      // the keep-alive pool instead of leaking it on error paths.
      await response.body?.cancel().catch(() => {
        /* already closed */
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    // Reject oversized responses before buffering the full body.
    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        // Same drain as the error branch above — otherwise the socket is
        // leaked out of the keep-alive pool.
        await response.body?.cancel().catch(() => {
          /* already closed */
        });
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    // Convertible documents (PDF/Office) take the markit path: binary fetch
    // capped by maxBytes, then document → markdown conversion. Detect before
    // the text path — `response.text()` on a PDF is binary garbage.
    const documentExtension = resolveDocumentExtension(url, contentType);
    if (documentExtension !== undefined) {
      return this.fetchDocument(response, documentExtension.extension, contentType, documentExtension.confident);
    }

    const body = await response.text();

    // Servers may omit content-length — measure again defensively.
    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    return this.extractTextResponse(body, contentType);
  }

  /** Text-path extraction shared by the normal flow and the document fallback. */
  private extractTextResponse(body: string, contentType: string): UrlFetchResult {
    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }
    return { content: this.extractMainContent(body), kind: 'extracted' };
  }

  /**
   * Fetch a convertible document (PDF/Office) as binary and convert it to
   * markdown via the markit engine (lazy-loaded, cached on disk).
   *
   * `confident` distinguishes detection strength: a convertible Content-Type
   * means conversion failure is a real error (corrupt document), while an
   * extension-only guess (e.g. an HTML viewer page at a .pdf URL) falls back
   * to the normal text extraction path instead of erroring (omp's behavior).
   */
  private async fetchDocument(
    response: Response,
    extension: string,
    contentType: string,
    confident: boolean,
  ): Promise<UrlFetchResult> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(bytes.byteLength)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    const converted = await convertBufferWithMarkit(
      bytes,
      extension,
      AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
    );
    if (!converted.ok) {
      if (!confident) {
        return this.extractTextResponse(new TextDecoder().decode(bytes), contentType);
      }
      throw new Error(`Document conversion failed (${extension}): ${converted.error ?? 'unknown error'}`);
    }
    return { content: converted.content, kind: 'extracted' };
  }

  private extractMainContent(html: string): string {
    // Readability mutates the DOM it parses, so parse twice — once for
    // the primary extractor and once for the fallback path.
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {
      // Fall through to the container-based fallback.
    }

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error(
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}
