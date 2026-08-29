<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ToolMessage } from '../types';
import { toolStatus } from '../utils/toolGroup';

const props = withDefaults(defineProps<{
  tool: ToolMessage;
  /** True while the owning turn is still streaming. */
  live?: boolean;
}>(), { live: true });

const status = computed(() => toolStatus(props.tool, props.live));

const statusIcon = computed(() => {
  switch (status.value) {
    case 'ok': return '✓';
    case 'error': return '✗';
    default: return '';
  }
});

const expanded = ref(false);
let userToggled = false;

// Auto-expand while running so streamed progress is visible; settle afterwards.
watch(status, (s) => {
  if (userToggled) return;
  expanded.value = s === 'running';
}, { immediate: true });

function toggle() {
  userToggled = true;
  expanded.value = !expanded.value;
}

/** Short one-line parameter summary for the header, e.g. `path="a.ts", cmd="ls"`. */
const paramSummary = computed(() => {
  const args = props.tool.args;
  if (!args || typeof args !== 'object') {
    return args === undefined ? '' : String(args);
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    let s: string;
    if (typeof v === 'string') s = v.length > 40 ? `${v.slice(0, 40)}…` : v;
    else {
      try { s = JSON.stringify(v); } catch { s = String(v); }
      if (s.length > 40) s = `${s.slice(0, 40)}…`;
    }
    parts.push(`${k}=${s}`);
    if (parts.length >= 3) break;
  }
  return parts.join('  ');
});

function formatArgs(): string {
  if (!props.tool.args) return '';
  try {
    return JSON.stringify(props.tool.args, null, 2);
  } catch {
    return String(props.tool.args);
  }
}

function formatOutput(s: string | undefined): string {
  return s ?? '';
}

/** Full output text (what would be rendered when expanded). */
const outputText = computed(() => formatOutput(props.tool.output));
const outputLarge = computed(() => outputText.value.length > 8192);
const outputExpanded = ref(false);
const outputShown = computed(() => (outputLarge.value && !outputExpanded.value ? outputText.value.slice(0, 280) : outputText.value));

async function copyOutput(): Promise<void> {
  try {
    await navigator.clipboard?.writeText(outputText.value);
  } catch {
    // Clipboard unavailable; ignore.
  }
}

/** Workdir-relative image output (e.g. browser/screenshot tools) → inline preview via the file gate. */
const imageSrc = computed(() => {
  const t = outputText.value.trim();
  if (!/^[\w@./-]+\.(png|jpe?g|gif|webp|avif)$/i.test(t)) return null;
  if (t.includes('..')) return null;
  if (t.startsWith('/')) return null;
  if (outputLarge.value) return null;
  return `/api/v1/files/raw?path=${encodeURIComponent(t)}`;
});
</script>

<template>
  <div :class="['tool-card', `is-${status}`]">
    <div class="tool-header" role="button" tabindex="0" @click="toggle" @keydown.enter.prevent="toggle">
      <span :class="['status-dot', status]">
        <template v-if="statusIcon">{{ statusIcon }}</template>
      </span>
      <span class="tool-name">{{ tool.name }}</span>
      <span v-if="paramSummary" class="tool-params" :title="paramSummary">{{ paramSummary }}</span>
      <span :class="['tool-chevron', { open: expanded }]">▸</span>
    </div>

    <div :class="['tool-collapse', { open: expanded }]">
      <div class="tool-collapse-inner">
        <div class="tool-body">
          <pre v-if="formatArgs()" class="tool-args"><code>{{ formatArgs() }}</code></pre>
          <pre v-if="tool.output !== undefined && !imageSrc" class="tool-result"><code>{{ outputShown || '(无输出)' }}</code></pre>
          <div v-if="tool.output !== undefined && imageSrc" class="tool-image-wrap">
            <img class="tool-image" :src="imageSrc" alt="" loading="lazy" @error="(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')" />
          </div>
          <div v-if="outputLarge" class="tool-output-actions">
            <button class="tool-output-btn" @click="outputExpanded = !outputExpanded">{{ outputExpanded ? '收起' : '展开全文' }}</button>
            <button class="tool-output-btn" @click="copyOutput">复制</button>
          </div>
          <div v-else class="tool-running-hint">执行中…</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-xs);
  overflow: hidden;
  font-size: var(--font-size-sm);
  animation: rise-in var(--dur-msg-assistant) var(--ease-out) both;
  transition: border-color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out);
}
.tool-card:hover {
  border-color: var(--color-line-strong);
}
.tool-card.is-running {
  border-color: var(--color-accent-bd);
}
.tool-card.is-error {
  border-color: var(--color-danger);
}
@media (prefers-reduced-motion: reduce) {
  .tool-card {
    animation: none;
  }
}

.tool-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  user-select: none;
  background: var(--color-surface-raised);
  transition: background var(--dur-fast) var(--ease-out);
}
.tool-header:hover {
  background: var(--color-hover);
}
.tool-header:active {
  background: var(--color-selected);
}
.tool-card.is-error .tool-header {
  background: var(--color-danger-soft);
}

.status-dot {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}
.status-dot.ok {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.status-dot.error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.status-dot.running {
  background: var(--gradient-accent);
  color: var(--color-on-accent);
  box-shadow: 0 0 8px var(--color-accent-glow);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}
.status-dot.suspended {
  background: var(--color-line-strong);
}
@media (prefers-reduced-motion: reduce) {
  .status-dot.running {
    animation: none;
  }
}

.tool-name {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  flex-shrink: 0;
}
.tool-params {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.tool-chevron {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  transition: transform var(--dur-base) var(--ease-out);
  flex-shrink: 0;
}
.tool-chevron.open {
  transform: rotate(90deg);
}

/* 0fr ↔ 1fr expand animation */
.tool-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}
.tool-collapse.open {
  grid-template-rows: 1fr;
}
.tool-collapse-inner {
  overflow: hidden;
  min-height: 0;
}

.tool-body {
  padding: var(--space-2) var(--space-3) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.tool-args,
.tool-result {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}
.tool-result {
  color: var(--color-text);
}
.tool-card.is-error .tool-result {
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.tool-running-hint {
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .tool-running-hint {
    animation: none;
  }
}
.tool-output-actions {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.tool-output-btn {
  min-height: 24px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tool-output-btn:hover {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
}
.tool-image-wrap {
  padding: var(--space-2);
}
.tool-image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-line);
}
</style>
