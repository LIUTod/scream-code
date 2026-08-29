<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { TurnStats } from '../types';

const props = defineProps<{ stats: TurnStats }>();

const elapsed = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

function stopClock() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startClock() {
  stopClock();
  const base = props.stats.llmMs ?? 0;
  const startedAt = Date.now();
  elapsed.value = base;
  timer = setInterval(() => {
    elapsed.value = base + (Date.now() - startedAt);
  }, 300);
}

watch(
  () => props.stats.status,
  (status) => {
    if (status === 'running') startClock();
    else stopClock();
  },
  { immediate: true },
);

onBeforeUnmount(stopClock);

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
</script>

<template>
  <div class="turn-stats" :class="`is-${stats.status}`" aria-live="polite">
    <template v-if="stats.status === 'running'">
      <span class="badge-gradient">正在思考</span>
      <span v-if="elapsed !== null" class="clock">{{ fmtMs(elapsed) }}</span>
    </template>
    <template v-else>
      <span class="stat">{{ stats.turn }} 轮 · {{ stats.step }} 步</span>
      <span class="dot">·</span>
      <span class="stat"><span class="k">LLM</span> {{ fmtMs(stats.llmMs) }}</span>
      <template v-if="stats.toolMs">
        <span class="dot">·</span>
        <span class="stat"><span class="k">工具</span> {{ fmtMs(stats.toolMs) }}</span>
      </template>
      <template v-if="stats.firstTokenMs !== null && stats.firstTokenMs !== undefined">
        <span class="dot">·</span>
        <span class="stat"><span class="k">首token</span> {{ fmtMs(stats.firstTokenMs) }}</span>
      </template>
      <template v-if="stats.tokens !== null && stats.tokens !== undefined">
        <span class="dot">·</span>
        <span class="stat"><span class="k">tokens</span> {{ fmtTokens(stats.tokens) }}</span>
      </template>
      <template v-if="stats.tokensPerSec !== null && stats.tokensPerSec !== undefined">
        <span class="dot">·</span>
        <span class="stat"><span class="k">tok/s</span> {{ stats.tokensPerSec }}</span>
      </template>
    </template>
  </div>
</template>

<style scoped>
.turn-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  user-select: none;
}

/* Gradient shimmer badge (accent-coloured, no external brand palette) */
.badge-gradient {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
  background-image: var(--gradient-accent);
  background-size: 200% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: turn-shimmer 1.8s linear infinite;
}

@keyframes turn-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .badge-gradient { animation: none; }
}

.clock {
  font-variant-numeric: tabular-nums;
  color: var(--color-text-faint);
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.k { opacity: 0.6; }
.dot { opacity: 0.4; }
</style>
