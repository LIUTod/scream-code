import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Code-highlighting session: one shared shiki highlighter singleton for the whole app,
 * one grammar loading state, and one document-level IntersectionObserver. Rationale:
 *   1. Pre-warm the high-frequency languages at startup and lazy-load the remaining
 *      grammars via dynamic import;
 *   2. A code block activates highlighting only when it first enters the viewport —
 *      inactive blocks cost nothing;
 *   3. Streaming rendering retokenizes incrementally per line, carrying grammar state
 *      across frames.
 */

export type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

/** Options type for codeToTokens (derived from the instance type to avoid depending on internal type exports). */
type TokenizeOptions = Parameters<Highlighter['codeToTokens']>[1];

/** High-frequency languages: registered during startup warm-up; the rest are lazy-loaded via dynamic import. */
export const EAGER_LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'bash', 'python', 'yaml'] as const;

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();
const failedLangs = new Set<string>();
const loadingLangs = new Map<string, Promise<void>>();

// Common aliases mapped to shiki grammar module names.
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash',
  shscript: 'bash', 'shell-script': 'bash', yml: 'yaml', md: 'markdown',
  rs: 'rust', rb: 'ruby', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
  'c++': 'cpp', cs: 'csharp', 'c#': 'csharp', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r',
  sql: 'sql', toml: 'toml', ini: 'ini', xml: 'xml', svelte: 'svelte',
  astro: 'astro', dockerfile: 'docker', makefile: 'make', graphql: 'graphql',
  proto: 'protobuf', pl: 'perl', pm: 'perl',
};

export function resolveLang(rawLang: string): string {
  const lower = rawLang.toLowerCase();
  return LANG_ALIASES[lower] ?? lower;
}

export async function ensureHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  const [githubDark, githubLight] = await Promise.all([
    import('shiki/themes/github-dark.mjs'),
    import('shiki/themes/github-light.mjs'),
  ]);
  highlighter = await createHighlighterCore({
    themes: [githubDark.default, githubLight.default],
    langs: [],
    // JavaScript regex engine: byte-for-byte identical output to oniguruma across samples
    // of all 33 supported languages, ~570KB smaller bundle (gzip ~212KB smaller), and no
    // wasm load/instantiation cost.
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

// Explicit import table for lazy-loaded languages.
// Note: template dynamic imports such as `import(`shiki/langs/${lang}.mjs`)` cannot be used —
// vite cannot statically analyze them, so the bare specifier is kept verbatim in the bundle and
// fails to resolve at runtime in the browser (i.e. production never actually lazy-loads anything).
// Listing each language explicitly lets vite split per-language chunks; unlisted languages fall
// back to plain-text rendering.
type LangInput = Parameters<Highlighter['loadLanguage']>[0];

const LANG_MODULE_LOADERS: Record<string, () => Promise<{ default: LangInput }>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  protobuf: () => import('shiki/langs/protobuf.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
};

export async function ensureLang(langName: string): Promise<boolean> {
  if (loadedLangs.has(langName)) return true;
  if (failedLangs.has(langName)) return false;
  const loader = LANG_MODULE_LOADERS[langName];
  if (!loader) {
    // Languages outside the whitelist have no chunk to split, so treat them as plain text.
    failedLangs.add(langName);
    return false;
  }
  if (loadingLangs.has(langName)) {
    await loadingLangs.get(langName);
    return loadedLangs.has(langName);
  }

  const promise = (async () => {
    try {
      const h = await ensureHighlighter();
      const mod = await loader();
      await h.loadLanguage(mod.default);
      loadedLangs.add(langName);
    } catch {
      // Grammar load failure: record it in the failed set so streaming does not retry it every frame.
      failedLangs.add(langName);
    }
  })();

  loadingLangs.set(langName, promise);
  await promise;
  loadingLangs.delete(langName);
  return loadedLangs.has(langName);
}

export function isLangLoaded(langName: string): boolean {
  return loadedLangs.has(langName);
}

/** HTML escaping (covers the three text-node essentials, matching browser innerHTML semantics). */
export function escapeHtmlCode(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Fallback plain-text pre that does not depend on highlighting results. */
export function plainPreHtml(code: string): string {
  return `<pre class="shiki-fallback"><code>${escapeHtmlCode(code)}</code></pre>`;
}

export interface StreamTokenBatch {
  /** Rendered HTML per line (wrapped in `<span class="line">`). */
  lines: string[];
  fg?: string;
  bg?: string;
  /** Grammar state after this batch completes; handed back in when the next frame continues. */
  grammarState: unknown;
}

/** Minimal token shape: structurally compatible with shiki's ThemedToken, without depending on its type export. */
interface TokenLike {
  content: string;
  color?: string;
  fontStyle?: number;
}

function tokenSpanHtml(token: TokenLike): string {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  if (token.fontStyle) {
    if (token.fontStyle & 1) styles.push('font-style:italic');
    if (token.fontStyle & 2) styles.push('font-weight:bold');
    if (token.fontStyle & 4) styles.push('text-decoration:underline');
  }
  const style = styles.length > 0 ? ` style="${styles.join(';')}"` : '';
  return `<span${style}>${escapeHtmlCode(token.content)}</span>`;
}

/**
 * Streaming incremental tokenize: processes only the completed lines added in this frame.
 * Grammar state is carried across frames by the caller (`grammarState` is the previous
 * batch's return value; pass null for the first batch).
 * Returns null when the highlighter or the grammar is not ready — the caller should fall
 * back to plain-text rendering.
 */
export function tokenizeStreamBatch(
  code: string,
  lang: string,
  theme: string,
  grammarState: unknown,
): StreamTokenBatch | null {
  if (!highlighter || !loadedLangs.has(lang)) return null;
  const options = { lang, theme } as TokenizeOptions;
  if (grammarState) options.grammarState = grammarState as TokenizeOptions['grammarState'];
  const result = highlighter.codeToTokens(code, options);
  return {
    lines: result.tokens.map((line) => `<span class="line">${line.map(tokenSpanHtml).join('')}</span>`),
    fg: result.fg,
    bg: result.bg,
    grammarState: result.grammarState ?? grammarState,
  };
}

// — Viewport activation: document-level shared IntersectionObserver —
//
// A code block activates highlighting only when it first enters the viewport (triggered
// 200px early so it is ready before the scroll arrives); activation is permanent afterwards.
// When every pending block unmounts, the observer disconnects for garbage collection.
// Environments without IntersectionObserver (e.g. jsdom in tests) get null and the caller
// falls back to the old "highlight everything immediately" path.

let viewportObserver: IntersectionObserver | null = null;
const pendingActivations = new Map<Element, () => void>();

function getViewportObserver(): IntersectionObserver {
  if (!viewportObserver) {
    viewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const activate = pendingActivations.get(entry.target);
          if (!activate) continue;
          pendingActivations.delete(entry.target);
          viewportObserver?.unobserve(entry.target);
          activate();
        }
        // Disconnect the shared observer once no blocks are pending, to avoid dangling references.
        if (pendingActivations.size === 0) {
          viewportObserver?.disconnect();
          viewportObserver = null;
        }
      },
      { rootMargin: '200px 0px' },
    );
  }
  return viewportObserver;
}

export function isViewportObserverAvailable(): boolean {
  return typeof IntersectionObserver !== 'undefined';
}

/**
 * Observes an element entering the viewport and calls onActivate on first visibility (once).
 * Returns a cancel function; returns null when IntersectionObserver is unavailable.
 */
export function observeCodeBlock(el: Element, onActivate: () => void): (() => void) | null {
  if (!isViewportObserverAvailable()) return null;
  pendingActivations.set(el, onActivate);
  getViewportObserver().observe(el);
  return () => {
    pendingActivations.delete(el);
    viewportObserver?.unobserve(el);
    if (pendingActivations.size === 0) {
      viewportObserver?.disconnect();
      viewportObserver = null;
    }
  };
}

// Warm-up: after module load, setTimeout(0) creates the highlighter singleton and registers
// the high-frequency languages, so the engine and grammars are ready when the first code block
// shows up, eliminating a 120ms+ long task.
// Only warm up in environments that support viewport activation; environments without
// IntersectionObserver fall back entirely to the old on-demand one-shot highlighting path.
if (isViewportObserverAvailable()) {
  setTimeout(() => {
    void ensureHighlighter().then(() => Promise.all(EAGER_LANGS.map((lang) => ensureLang(lang))));
  }, 0);
}
