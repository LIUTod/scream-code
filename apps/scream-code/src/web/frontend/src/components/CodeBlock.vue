<script setup lang="ts">
import { ref, watch, inject } from 'vue';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

const props = defineProps<{
  code: string;
  lang?: string;
  /** True while the enclosing message is still streaming. */
  streaming?: boolean;
}>();

const effectiveTheme = inject<import('vue').Ref<'light' | 'dark'>>(
  'effectiveTheme',
  ref(typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
);

const highlighted = ref('');
/** Lightweight escaped rendering used while streaming (no shiki highlight). */
const plainHtml = ref('');
const copied = ref(false);

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();
const loadingLangs = new Map<string, Promise<void>>();

// Common aliases mapped to shiki language module names.
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

async function ensureHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  const [githubDark, githubLight] = await Promise.all([
    import('shiki/themes/github-dark.mjs'),
    import('shiki/themes/github-light.mjs'),
  ]);
  highlighter = await createHighlighterCore({
    themes: [githubDark.default, githubLight.default],
    langs: [],
    engine: createOnigurumaEngine(() => import('shiki/wasm')),
  });
  return highlighter;
}

async function ensureLang(langName: string): Promise<boolean> {
  if (loadedLangs.has(langName)) return true;
  if (loadingLangs.has(langName)) {
    await loadingLangs.get(langName);
    return loadedLangs.has(langName);
  }

  const promise = (async () => {
    try {
      const h = await ensureHighlighter();
      // Try to dynamically import the language grammar.
      const mod = await import(`shiki/langs/${langName}.mjs`);
      await h.loadLanguage(mod.default);
      loadedLangs.add(langName);
    } catch {
      // Language not available in shiki - will fall back to plaintext.
    }
  })();

  loadingLangs.set(langName, promise);
  await promise;
  loadingLangs.delete(langName);
  return loadedLangs.has(langName);
}

function resolveLang(rawLang: string): string {
  const lower = rawLang.toLowerCase();
  return LANG_ALIASES[lower] ?? lower;
}

async function render() {
  const rawLang = props.lang?.toLowerCase() ?? 'text';
  const langName = resolveLang(rawLang);
  const theme = effectiveTheme.value === 'light' ? 'github-light' : 'github-dark';

  try {
    const h = await ensureHighlighter();
    const loaded = await ensureLang(langName);
    if (loaded) {
      highlighted.value = h.codeToHtml(props.code, { lang: langName, theme });
    } else {
      highlighted.value = `<pre class="shiki-fallback"><code>${escapeHtml(props.code)}</code></pre>`;
    }
  } catch {
    highlighted.value = `<pre class="shiki-fallback"><code>${escapeHtml(props.code)}</code></pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function copy() {
  navigator.clipboard.writeText(props.code).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  });
}

watch(
  () => [props.code, props.lang, effectiveTheme.value] as const,
  ([code]) => {
    if (props.streaming) {
      // During streaming, skip shiki highlighting (expensive per chunk) and
      // render a lightweight escaped plain-text fallback instead.
      plainHtml.value = `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
    } else {
      void render();
    }
  },
  { immediate: true },
);

watch(
  () => props.streaming,
  (streaming, wasStreaming) => {
    if (wasStreaming && !streaming) {
      // Fence just closed: do the real highlight once with the final code.
      void render();
    }
  },
);
</script>

<template>
  <div class="code-block">
    <div class="code-header">
      <span class="code-lang">{{ lang || 'text' }}</span>
      <button :class="['code-copy', { copied }]" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
    </div>
    <div class="code-content" v-html="props.streaming ? plainHtml : (highlighted || plainHtml)"></div>
  </div>
</template>

<style scoped>
.code-block {
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  margin: 0.75em 0;
  overflow: hidden;
}
.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-1) var(--space-3);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  font-size: var(--font-size-xs);
}
.code-lang {
  color: var(--color-text-muted);
  text-transform: lowercase;
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
}
.code-copy {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 1px solid var(--color-line);
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  cursor: pointer;
  font-size: var(--font-size-xs);
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.code-copy:hover {
  color: var(--color-text);
  border-color: var(--color-line-strong);
  background: var(--color-hover);
}
.code-copy:active {
  transform: translateY(1px);
  background: var(--color-selected);
}
.code-copy.copied {
  color: var(--color-success);
  border-color: var(--color-success);
  background: var(--color-success-soft);
}
.code-content :deep(pre) {
  margin: 0;
  padding: var(--space-3);
  overflow-x: auto;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  font-family: var(--font-mono);
}
.code-content :deep(code) {
  font-family: var(--font-mono);
}
.code-content :deep(.line) { display: block; }
.code-content :deep(.line.add) { background: var(--color-success-soft); box-shadow: inset 2px 0 0 var(--color-success); }
.code-content :deep(.line.del) { background: var(--color-danger-soft); box-shadow: inset 2px 0 0 var(--color-danger); }
.code-content :deep(.shiki-fallback) {
  margin: 0;
  padding: var(--space-3);
  overflow-x: auto;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  font-family: var(--font-mono);
}
@media (max-width: 640px) {
  .code-copy { min-height: 44px; padding: var(--space-1) var(--space-3); }
}
</style>
