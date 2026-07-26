<script setup lang="ts">
import { ref, watch } from 'vue';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

const props = defineProps<{
  code: string;
  lang?: string;
}>();

const highlighted = ref('');
const copied = ref(false);

let highlighter: Awaited<ReturnType<typeof createHighlighterCore>> | null = null;

async function ensureHighlighter() {
  if (highlighter) return highlighter;
  const [githubDark, githubLight, js, ts, py, bash, json, yaml, html, css, vue, diff] = await Promise.all([
    import('shiki/themes/github-dark.mjs'),
    import('shiki/themes/github-light.mjs'),
    import('shiki/langs/javascript.mjs'),
    import('shiki/langs/typescript.mjs'),
    import('shiki/langs/python.mjs'),
    import('shiki/langs/bash.mjs'),
    import('shiki/langs/json.mjs'),
    import('shiki/langs/yaml.mjs'),
    import('shiki/langs/html.mjs'),
    import('shiki/langs/css.mjs'),
    import('shiki/langs/vue.mjs'),
    import('shiki/langs/diff.mjs'),
  ]);
  highlighter = await createHighlighterCore({
    themes: [githubDark.default, githubLight.default],
    langs: [js.default, ts.default, py.default, bash.default, json.default, yaml.default, html.default, css.default, vue.default, diff.default],
    engine: createOnigurumaEngine(() => import('shiki/wasm')),
  });
  return highlighter;
}

async function render() {
  const lang = props.lang?.toLowerCase() ?? 'text';
  const supportedLangs = new Set(['javascript', 'typescript', 'python', 'bash', 'shell', 'json', 'yaml', 'html', 'css', 'vue', 'diff']);
  const effectiveLang = supportedLangs.has(lang) ? lang : lang === 'js' ? 'javascript' : lang === 'ts' ? 'typescript' : lang === 'py' ? 'python' : lang === 'sh' ? 'bash' : 'text';
  const theme = document.documentElement.dataset.theme === 'light' ? 'github-light' : 'github-dark';

  try {
    const h = await ensureHighlighter();
    highlighted.value = h.codeToHtml(props.code, { lang: effectiveLang, theme });
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
  () => [props.code, props.lang, document.documentElement.dataset.theme],
  () => render(),
  { immediate: true },
);
</script>

<template>
  <div class="code-block">
    <div class="code-header">
      <span class="code-lang">{{ lang || 'text' }}</span>
      <button class="code-copy" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
    </div>
    <div class="code-content" v-html="highlighted"></div>
  </div>
</template>

<style scoped>
.code-block {
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: 8px;
  margin: 0.75em 0;
  overflow: hidden;
}
.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  font-size: 12px;
}
.code-lang {
  color: var(--color-text-muted);
  text-transform: lowercase;
  font-family: "SF Mono", "Cascadia Code", monospace;
}
.code-copy {
  background: transparent;
  border: 1px solid var(--color-line);
  color: var(--color-text-muted);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
}
.code-copy:hover {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}
.code-content :deep(pre) {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
}
.code-content :deep(code) {
  font-family: "SF Mono", "Cascadia Code", monospace;
}
.code-content :deep(.line) { display: block; }
.code-content :deep(.line.add) { background: #23863633; }
.code-content :deep(.line.del) { background: #da363333; }
</style>
