<script setup lang="ts">
import { ref, computed, watch, inject, onMounted, onBeforeUnmount } from 'vue';
import {
  ensureHighlighter,
  ensureLang,
  isLangLoaded,
  isViewportObserverAvailable,
  observeCodeBlock,
  plainPreHtml,
  resolveLang,
  tokenizeStreamBatch,
} from '../utils/codeHighlight';

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
/** 轻量转义纯文本：流式期间未激活视口或 grammar 未就绪时的兜底渲染。 */
const plainHtml = ref('');
const copied = ref(false);

// —— 视口激活 ——
// 有 IntersectionObserver 的环境：进入视口才激活高亮，激活后永久有效；
// 没有的环境（如测试 jsdom）回退旧行为——立即一次性高亮。
const ioAvailable = isViewportObserverAvailable();
const active = ref(!ioAvailable);
let cancelObserve: (() => void) | null = null;
const rootEl = ref<HTMLElement | null>(null);

// —— 流式增量状态 ——
// 每行缓存渲染好的 HTML；grammar 状态跨帧续算，每帧只 tokenize 新增完成行。
const streamLines = ref<string[]>([]);
/** 当前半行原文：模板里用文本插值渲染，天然转义（轻量路径）。 */
const streamPartial = ref('');
const streamShell = ref<{ theme: string; style: string } | null>(null);
let grammarState: unknown = null;
let streamLang = '';
let streamTheme = '';
/** 流式 DOM 当前已完整覆盖的源码：settle 时判断“能否认领现有 DOM”的基准。 */
let lastStreamCode = '';
/** 整段渲染去重：同参数只渲染一次，settle 同帧双 watch 触发时抑制重复。 */
let lastRenderKey: string | null = null;
let pendingRenderKey: string | null = null;
/** 已发起加载但未就位的语言，避免流式每帧重复触发加载。 */
const kickAttempted = new Set<string>();

// 每 32 行一个分组容器：新增行只追加到最后一个分组，已完行的 DOM 原封不动。
const GROUP_SIZE = 32;
const streamGroups = computed(() => {
  const lines = streamLines.value;
  const groups: Array<{ key: number; html: string }> = [];
  for (let i = 0; i < lines.length; i += GROUP_SIZE) {
    groups.push({ key: i, html: lines.slice(i, i + GROUP_SIZE).join('') });
  }
  return groups;
});

function resetStreamState() {
  streamLines.value = [];
  streamPartial.value = '';
  streamShell.value = null;
  grammarState = null;
}

function kickLang(langName: string) {
  if (kickAttempted.has(langName)) return;
  kickAttempted.add(langName);
  void ensureLang(langName).then((ok) => {
    if (!ok || !props.streaming || langName !== streamLang) return;
    // grammar 就绪后自动补高亮。
    updateStreaming();
  });
}

/**
 * 让「流式增量状态」追上当前 props.code（流式帧与 settle 末帧共用）。
 * 返回 true 仅当 streamShell 已经渲染出 props.code 的全部内容——此时 DOM 就是
 * 最终形态，调用方（settle 路径）可以认领它，不必整段替换。
 */
function advanceStreamDom(): boolean {
  const langName = resolveLang(props.lang?.toLowerCase() ?? 'text');
  const theme = effectiveTheme.value === 'light' ? 'github-light' : 'github-dark';

  if (langName !== streamLang || theme !== streamTheme) {
    // 语言或主题变化：行缓存与 grammar 状态一并作废，从头增量。
    resetStreamState();
    streamLang = langName;
    streamTheme = theme;
  }

  // 视口未激活或 grammar 未就绪：整段走轻量纯文本（含当前半行）。
  if (!active.value || !ioAvailable || !isLangLoaded(langName)) {
    plainHtml.value = plainPreHtml(props.code);
    if (active.value && ioAvailable && !isLangLoaded(langName)) kickLang(langName);
    return false;
  }

  const text = props.code;
  const nl = text.lastIndexOf('\n');
  // 未闭合围栏只处理已完成行：最后一个换行之后的内容是当前半行。
  const completedText = nl === -1 ? '' : text.slice(0, nl);
  const partial = nl === -1 ? text : text.slice(nl + 1);
  const completed = nl === -1 ? [] : completedText.split('\n');

  // 流可能回卷（重试改写等），缓存行数多于新行数时整体作废重算。
  if (completed.length < streamLines.value.length) resetStreamState();

  const freshLines = completed.slice(streamLines.value.length);
  if (freshLines.length > 0) {
    const batch = tokenizeStreamBatch(freshLines.join('\n'), langName, theme, grammarState);
    if (!batch) {
      plainHtml.value = plainPreHtml(text);
      return false;
    }
    grammarState = batch.grammarState;
    if (!streamShell.value) {
      streamShell.value = {
        theme,
        style: `background-color:${batch.bg};color:${batch.fg}`,
      };
    }
    streamLines.value = streamLines.value.concat(batch.lines);
  }
  if (!streamShell.value) {
    // 还没有任何已完成行（单行代码块）：没有可认领的流式 DOM。
    plainHtml.value = plainPreHtml(text);
    return false;
  }
  streamPartial.value = partial;
  // 只有走到这里，DOM 才真正覆盖了这份代码——settle 的"是否已覆盖"判定基准。
  lastStreamCode = text;
  return true;
}

function updateStreaming() {
  if (!props.streaming) return;
  advanceStreamDom();
}

/**
 * settle 认领：流式 DOM 已覆盖最终代码时保留它（不换 DOM、不重渲染）。
 *
 * 为什么需要这层判断：streaming.ts 的 turn.ended 先 flushNow() 发布末帧 delta，
 * 同一个 tick 再置 busy=false —— code 与 streaming 会落在同一次 Vue flush 里。
 * 此时 code 已经变过，旧逻辑（只有"代码未变"才保留）必然走整段 render() 并把
 * streamShell 置空，把增量 DOM 全换成新节点：流式末尾闪一下。先把增量状态推进
 * 到最终代码再判断覆盖，才能让这条真实时序也走"认领"分支。
 * 非追加变化（重试改写、编辑）交回整段渲染，不往流式行缓存里塞任意内容。
 */
function claimStreamDom(): boolean {
  if (!streamShell.value) return false;
  if (props.code === lastStreamCode) return true;
  if (!props.code.startsWith(lastStreamCode)) return false;
  return advanceStreamDom();
}

/** 内容/流式状态变化后的统一出口：优先认领流式 DOM，失败才整段重渲染。 */
function syncOrRender(): void {
  if (props.streaming) {
    updateStreaming();
    return;
  }
  if (claimStreamDom()) return;
  void render();
}

function onViewportActivate() {
  active.value = true;
  if (props.streaming) updateStreaming();
  else void render();
}

async function render() {
  // 视口未激活的块先给纯文本兜底，进入视口后由 onViewportActivate 触发高亮。
  if (!active.value) {
    plainHtml.value = plainPreHtml(props.code);
    return;
  }
  const langName = resolveLang(props.lang?.toLowerCase() ?? 'text');
  const theme = effectiveTheme.value === 'light' ? 'github-light' : 'github-dark';
  const key = `${props.code}${langName}${theme}`;
  // code 与 streaming 两个 watch 在 settle 同帧可能连续触发 render，
  // 同参数整段渲染只执行一次，避免重复的全量 tokenize。
  if (key === lastRenderKey || key === pendingRenderKey) return;
  pendingRenderKey = key;

  try {
    const h = await ensureHighlighter();
    const loaded = await ensureLang(langName);
    if (loaded) {
      highlighted.value = h.codeToHtml(props.code, { lang: langName, theme });
    } else {
      highlighted.value = plainPreHtml(props.code);
    }
  } catch {
    highlighted.value = plainPreHtml(props.code);
  } finally {
    pendingRenderKey = null;
    lastRenderKey = key;
  }
  // 整段渲染接管视图：丢弃流式 DOM（此时 highlighted 已是最新，避免闪烁）。
  streamShell.value = null;
}

function copy() {
  navigator.clipboard.writeText(props.code).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  });
}

onMounted(() => {
  if (!rootEl.value) return;
  cancelObserve = observeCodeBlock(rootEl.value, onViewportActivate);
});

onBeforeUnmount(() => {
  cancelObserve?.();
});

watch(
  () => [props.code, props.lang, effectiveTheme.value] as const,
  () => syncOrRender(),
  { immediate: true },
);

watch(
  () => props.streaming,
  (streaming, wasStreaming) => {
    // 回合结束：流式 DOM 已覆盖最终代码时原样保留，不换 DOM 不重渲染。
    if (wasStreaming && !streaming) syncOrRender();
  },
);
</script>

<template>
  <div class="code-block" ref="rootEl">
    <div class="code-header">
      <span class="code-lang">{{ lang || 'text' }}</span>
      <button :class="['code-copy', { copied }]" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
    </div>
    <div class="code-content">
      <!-- Streaming incremental DOM: grouped v-html keeps completed lines byte-identical
           while the tail grows char by char; the whole element must stay on one line
           so the <pre> gets no stray whitespace text nodes. -->
      <pre v-if="streamShell" class="shiki" :class="streamShell.theme" :style="streamShell.style" tabindex="0"><code><span v-for="g in streamGroups" :key="g.key" class="shiki-group" v-html="g.html"></span><span v-if="streamPartial" class="line">{{ streamPartial }}</span></code></pre>
      <div v-else v-html="props.streaming ? plainHtml : (highlighted || plainHtml)"></div>
    </div>
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
  transition: transform var(--dur-fast) var(--ease-out);
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
/* 行分组容器：视觉中性，只为圈住 32 行已完行的 DOM，增量追加时整块复用 */
.code-content :deep(.shiki-group) { display: block; }
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
