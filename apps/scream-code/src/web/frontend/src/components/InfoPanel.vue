<script setup lang="ts">
import { computed } from 'vue';
import type { SessionStatus, SessionUsage, TokenUsage } from '../types';
import Dialog from './ui/Dialog.vue';

const props = defineProps<{
  mode: 'status' | 'usage';
  status: SessionStatus;
  sessionId: string | null;
  workDir: string | null;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const heading = computed(() => (props.mode === 'status' ? '会话状态' : 'Token 用量'));

function permLabel(p?: string): string {
  switch (p) {
    case 'auto': return '自动 (auto)';
    case 'yolo': return 'YOLO';
    case 'manual': return '手动 (manual)';
    default: return p ?? '-';
  }
}
function boolLabel(v?: boolean): string {
  return v ? '开启' : '关闭';
}
function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}
function fmtNum(n?: number): string {
  return typeof n === 'number' ? n.toLocaleString() : '-';
}
function usagePct(v?: number): string {
  if (typeof v !== 'number') return '-';
  const p = v > 1 ? v : v * 100;
  return `${p.toFixed(1)}%`;
}
function sumTokens(u?: TokenUsage): number {
  if (!u) return 0;
  return u.inputOther + u.output + u.inputCacheRead + u.inputCacheCreation;
}
interface ModelRow { model: string; tokens: number; output: number; cacheRead: number; }
function modelRows(u?: SessionUsage): ModelRow[] {
  if (!u?.byModel) return [];
  return Object.entries(u.byModel).map(([model, t]) => ({
    model,
    tokens: sumTokens(t),
    output: t.output,
    cacheRead: t.inputCacheRead,
  }));
}
const hasUsage = computed(() => present(props.status.usage) || present(props.status.contextTokens));
</script>

<template>
  <Dialog :open="true" :title="heading" @close="emit('close')">
    <template v-if="mode === 'status'">
      <div class="info-row"><span class="info-key">会话 ID</span><span class="info-val mono">{{ sessionId ?? '-' }}</span></div>
      <div class="info-row"><span class="info-key">工作目录</span><span class="info-val mono">{{ workDir ?? '-' }}</span></div>
      <div class="info-row"><span class="info-key">模型</span><span class="info-val">{{ status.model ?? '-' }}</span></div>
      <div class="info-row"><span class="info-key">权限模式</span><span class="info-val">{{ permLabel(status.permission) }}</span></div>
      <div class="info-row"><span class="info-key">思考级别</span><span class="info-val">{{ status.thinkingLevel ?? '-' }}</span></div>
      <div class="info-row"><span class="info-key">计划模式</span><span class="info-val">{{ boolLabel(status.planMode) }}</span></div>
      <div class="info-row"><span class="info-key">WolfPack 模式</span><span class="info-val">{{ boolLabel(status.wolfpackMode) }}</span></div>
      <div class="info-row"><span class="info-key">上下文</span><span class="info-val">{{ fmtNum(status.contextTokens) }} / {{ fmtNum(status.maxContextTokens) }} ({{ usagePct(status.contextUsage) }})</span></div>
    </template>
    <template v-else>
      <div class="info-row"><span class="info-key">上下文 Token</span><span class="info-val">{{ fmtNum(status.contextTokens) }} / {{ fmtNum(status.maxContextTokens) }}</span></div>
      <div class="info-row"><span class="info-key">上下文占比</span><span class="info-val">{{ usagePct(status.contextUsage) }}</span></div>
      <div v-if="status.usage?.total" class="info-row"><span class="info-key">累计 Token</span><span class="info-val">{{ fmtNum(sumTokens(status.usage.total)) }}</span></div>
      <div v-if="status.usage?.currentTurn" class="info-row"><span class="info-key">当前回合</span><span class="info-val">{{ fmtNum(sumTokens(status.usage.currentTurn)) }}</span></div>
      <template v-if="modelRows(status.usage).length">
        <div class="info-subhead">按模型</div>
        <div v-for="row in modelRows(status.usage)" :key="row.model" class="info-row info-row-model">
          <span class="info-val mono">{{ row.model }}</span>
          <span class="info-val">{{ fmtNum(row.tokens) }}（输出 {{ fmtNum(row.output) }} · 缓存读 {{ fmtNum(row.cacheRead) }}）</span>
        </div>
      </template>
      <div v-if="!hasUsage" class="info-empty">暂无用量数据</div>
    </template>
  </Dialog>
</template>

<style scoped>
.info-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-line);
  font-size: var(--font-size-sm);
}
.info-row:last-child {
  border-bottom: none;
}
.info-row-model {
  justify-content: flex-start;
  flex-direction: column;
  gap: var(--space-1);
}
.info-key {
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.info-val {
  color: var(--color-text);
  text-align: right;
  word-break: break-all;
  font-variant-numeric: tabular-nums;
}
.info-row-model .info-val {
  text-align: left;
}
.mono {
  font-family: var(--font-mono);
}
.info-subhead {
  margin-top: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.info-empty {
  padding: var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
}
</style>
