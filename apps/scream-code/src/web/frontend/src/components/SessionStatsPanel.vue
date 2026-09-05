<!-- Dropdown panel under the conversation header's stats button.
     Data is all real: currentTurn comes over WS, totals come from
     GET /sessions/:id/usage, context watermark from /sessions/:id/context.
     TokenUsage carries four counters only (no cost field), so the panel
     shows those four and never invents a price. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SessionStatus, SessionUsage, TokenUsage } from '../types';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{
  status: SessionStatus;
  fetchUsage: () => Promise<void>;
  fetchContext: () => Promise<void>;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const rootRef = ref<HTMLElement | null>(null);

onMounted(() => {
  void props.fetchUsage();
  void props.fetchContext();
});

function onPointerDown(e: PointerEvent): void {
  const root = rootRef.value;
  if (root && !root.contains(e.target as Node)) emit('close');
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeydown);
});

function sumTokens(u?: TokenUsage): number {
  if (!u) return 0;
  return u.inputOther + u.output + u.inputCacheRead + u.inputCacheCreation;
}
function fmtToken(n?: number): string {
  if (typeof n !== 'number') return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtNum(n?: number): string {
  return typeof n === 'number' ? n.toLocaleString() : '-';
}

/** Context watermark in percent (0..100). contextUsage may be a fraction or a
 *  percent; fall back to tokens/max when it is absent. */
const contextPct = computed(() => {
  const u = props.status.contextUsage;
  if (typeof u === 'number' && Number.isFinite(u)) {
    const p = u > 1 ? u : u * 100;
    return Math.max(0, Math.min(p, 100));
  }
  const cur = props.status.contextTokens ?? 0;
  const max = props.status.maxContextTokens ?? 0;
  if (max <= 0) return 0;
  return Math.max(0, Math.min((cur / max) * 100, 100));
});

const contextLabel = computed(() => {
  if (typeof props.status.contextTokens === 'number' && typeof props.status.maxContextTokens === 'number') {
    return `${fmtNum(props.status.contextTokens)} / ${fmtNum(props.status.maxContextTokens)}`;
  }
  return contextPct.value > 0 ? `${contextPct.value.toFixed(1)}%` : '-';
});

const total = computed(() => props.status.usage?.total);
const currentTurn = computed(() => props.status.usage?.currentTurn);
const totalSum = computed(() => sumTokens(total.value));

interface ModelRow {
  model: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}
const modelRows = computed<ModelRow[]>(() => {
  const byModel = props.status.usage?.byModel;
  if (!byModel) return [];
  return Object.entries(byModel).map(([model, t]) => ({
    model,
    tokens: sumTokens(t),
    input: t.inputOther,
    output: t.output,
    cacheRead: t.inputCacheRead,
    cacheCreation: t.inputCacheCreation,
  }));
});
const hasUsage = computed(() => totalSum.value > 0 || modelRows.value.length > 0 || sumTokens(currentTurn.value) > 0);

interface DimRow { key: string; label: string; value: number | undefined; }
const dims = computed<DimRow[]>(() => [
  { key: 'input', label: '输入', value: total.value?.inputOther },
  { key: 'output', label: '输出', value: total.value?.output },
  { key: 'cacheRead', label: '缓存读', value: total.value?.inputCacheRead },
  { key: 'cacheCreation', label: '缓存写', value: total.value?.inputCacheCreation },
]);
</script>

<template>
  <div ref="rootRef" class="stats-panel" role="dialog" aria-label="会话统计">
    <div class="stats-head">
      <span class="stats-title">会话统计</span>
      <button class="stats-close" aria-label="关闭统计面板" @click="emit('close')">
        <SvgIcon name="x" :size="14" />
      </button>
    </div>

    <div class="stats-body">
      <!-- Context watermark -->
      <div class="stats-section">
        <div class="stats-label-row">
          <span class="stats-label">上下文水位</span>
          <span class="stats-value mono">{{ contextLabel }}</span>
        </div>
        <div
          class="ctx-track"
          role="progressbar"
          :aria-valuenow="Math.round(contextPct)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`上下文 ${contextPct.toFixed(1)}%`"
        >
          <div class="ctx-fill" :style="{ width: `${contextPct}%` }" />
        </div>
      </div>

      <template v-if="hasUsage">
        <!-- Current turn -->
        <div v-if="sumTokens(currentTurn) > 0" class="stats-section">
          <div class="stats-label-row">
            <span class="stats-label">当前回合</span>
            <span class="stats-value mono">{{ fmtToken(sumTokens(currentTurn)) }} tokens</span>
          </div>
        </div>

        <!-- Session totals -->
        <div class="stats-section">
          <div class="stats-label-row">
            <span class="stats-label">本会话累计</span>
            <span class="stats-value mono">{{ fmtToken(totalSum) }} tokens</span>
          </div>
          <div class="stats-grid">
            <div v-for="d in dims" :key="d.key" class="stats-cell">
              <span class="stats-cell-label">{{ d.label }}</span>
              <span class="stats-cell-value mono">{{ fmtNum(d.value) }}</span>
            </div>
          </div>
        </div>

        <!-- Per-model breakdown -->
        <div v-if="modelRows.length > 0" class="stats-section">
          <div class="stats-label">按模型</div>
          <div v-for="row in modelRows" :key="row.model" class="model-row">
            <span class="model-name" :title="row.model">{{ row.model }}</span>
            <span class="model-tokens mono">{{ fmtNum(row.tokens) }}</span>
            <span class="model-dims mono">
              入 {{ fmtNum(row.input) }} · 出 {{ fmtNum(row.output) }} · 缓存 {{ fmtNum(row.cacheRead + row.cacheCreation) }}
            </span>
          </div>
        </div>
      </template>
      <div v-else class="stats-empty">暂无用量数据</div>
    </div>
  </div>
</template>

<style scoped>
.stats-panel {
  width: min(340px, calc(100vw - var(--space-6)));
  max-height: min(70vh, 420px);
  overflow: auto;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
}
.stats-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-line);
  flex-shrink: 0;
}
.stats-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
}
.stats-close {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.stats-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.stats-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) var(--space-4);
}
.stats-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.stats-label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.stats-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.stats-value {
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.ctx-track {
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-selected);
  overflow: hidden;
}
.ctx-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  transition: width var(--dur-base) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .ctx-fill { transition: none; }
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1);
}
.stats-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
}
.stats-cell-label {
  font-size: 11px;
  color: var(--color-text-faint);
}
.stats-cell-value {
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: var(--space-2);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--color-line);
  font-size: var(--font-size-xs);
}
.model-row:last-child {
  border-bottom: none;
}
.model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.model-tokens {
  color: var(--color-text);
}
.model-dims {
  grid-column: 1 / -1;
  color: var(--color-text-faint);
}
.stats-empty {
  padding: var(--space-3);
  text-align: center;
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
}
</style>
