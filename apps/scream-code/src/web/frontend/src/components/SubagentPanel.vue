<script setup lang="ts">
import { computed } from 'vue';
import type { SubagentActivity } from '../types';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{ subagents: readonly SubagentActivity[] }>();

const activeCount = computed(() =>
  props.subagents.filter((agent) => agent.state === 'spawning' || agent.state === 'running').length,
);

function stateLabel(agent: SubagentActivity): string {
  if (agent.state === 'spawning') return agent.runInBackground ? '后台排队' : '准备中';
  if (agent.state === 'running') return agent.runInBackground ? '后台运行' : '运行中';
  if (agent.state === 'completed') return '已完成';
  return '失败';
}

function formatDuration(value: number | undefined): string | null {
  if (value === undefined || value < 0) return null;
  if (value < 1_000) return '< 1 秒';
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1_000)} 秒`;
}

function tokenCount(agent: SubagentActivity): number | null {
  const usage = agent.usage;
  if (!usage) return null;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}
</script>

<template>
  <section class="subagents-panel" aria-label="协作代理">
    <header class="agents-head">
      <div class="agents-heading">
        <span class="agents-icon"><SvgIcon name="bot" :size="16" /></span>
        <div>
          <h2>协作代理</h2>
          <p role="status" aria-live="polite">{{ activeCount > 0 ? `${activeCount} 个正在执行` : '最近的子代理执行记录' }}</p>
        </div>
      </div>
      <span v-if="activeCount > 0" class="active-count" :aria-label="`${activeCount} 个代理正在执行`">{{ activeCount }}</span>
    </header>

    <div class="agents-body">
      <p v-if="subagents.length === 0" class="agents-empty">当前会话还没有子代理活动</p>
      <ol v-else class="agent-list">
        <li v-for="agent in subagents" :key="agent.subagentId" class="agent-row">
          <div class="agent-row-head">
            <span class="agent-mark" :class="agent.state" aria-hidden="true">
              <SvgIcon :name="agent.state === 'failed' ? 'x' : agent.state === 'completed' ? 'check' : 'bot'" :size="14" />
            </span>
            <div class="agent-title">
              <strong>{{ agent.name }}</strong>
              <span v-if="agent.runInBackground" class="background-badge">后台</span>
              <span v-if="agent.description" class="agent-description">{{ agent.description }}</span>
            </div>
            <span class="agent-state" :class="agent.state">{{ stateLabel(agent) }}</span>
          </div>

          <p v-if="agent.error" class="agent-result error">{{ agent.error }}</p>
          <p v-else-if="agent.resultSummary" class="agent-result">{{ agent.resultSummary }}</p>

          <dl v-if="agent.turns || agent.toolCallCount || formatDuration(agent.durationMs) || tokenCount(agent) !== null" class="agent-meta">
            <div v-if="agent.turns"><dt>回合</dt><dd>{{ agent.turns }}</dd></div>
            <div v-if="agent.toolCallCount"><dt>工具</dt><dd>{{ agent.toolCallCount }}</dd></div>
            <div v-if="formatDuration(agent.durationMs)"><dt>耗时</dt><dd>{{ formatDuration(agent.durationMs) }}</dd></div>
            <div v-if="tokenCount(agent) !== null"><dt>Token</dt><dd>{{ formatNumber(tokenCount(agent)!) }}</dd></div>
          </dl>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.subagents-panel {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  background: var(--color-surface);
}
.agents-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.agents-heading { display: flex; align-items: center; min-width: 0; gap: var(--space-2); }
.agents-icon,
.agent-mark {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
}
.agents-icon {
  width: 28px;
  height: 28px;
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
}
h2 { margin: 0; color: var(--color-text); font-size: var(--font-size-sm); font-weight: 650; }
.agents-heading p { margin: 2px 0 0; color: var(--color-text-faint); font-size: var(--font-size-xs); }
.active-count {
  min-width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-full);
  color: var(--color-on-accent);
  background: var(--color-accent);
  font: 650 var(--font-size-xs) var(--font-mono);
}
.agents-body { overflow-y: auto; padding: 0 var(--space-3); }
.agents-empty {
  margin: 0;
  padding: var(--space-6) var(--space-2);
  color: var(--color-text-faint);
  text-align: center;
  font-size: var(--font-size-sm);
}
.agent-list { margin: 0; padding: 0; list-style: none; }
.agent-row { padding: var(--space-3) 0; border-bottom: 1px solid var(--color-line); }
.agent-row:last-child { border-bottom: 0; }
.agent-row-head { display: flex; align-items: flex-start; min-width: 0; gap: var(--space-2); }
.agent-mark { width: 24px; height: 24px; color: var(--color-text-muted); background: var(--color-surface-sunken); }
.agent-mark.running,
.agent-mark.spawning { color: var(--color-on-accent); background: var(--color-accent); }
.agent-mark.completed { color: var(--color-success); background: var(--color-success-soft); }
.agent-mark.failed { color: var(--color-danger); background: var(--color-danger-soft); }
.agent-title { display: grid; min-width: 0; flex: 1; gap: 2px; }
.agent-title strong { overflow: hidden; color: var(--color-text); font-size: var(--font-size-sm); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.agent-description { overflow: hidden; color: var(--color-text-faint); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.background-badge { width: fit-content; padding: 1px 5px; border: 1px solid var(--color-line); border-radius: var(--radius-xs); color: var(--color-text-faint); font-size: 10px; font-weight: 600; }
.agent-state { flex-shrink: 0; padding-top: 3px; color: var(--color-text-faint); font-size: var(--font-size-xs); }
.agent-state.running,
.agent-state.spawning { color: var(--color-info); }
.agent-state.completed { color: var(--color-success); }
.agent-state.failed { color: var(--color-danger); }
.agent-result { display: -webkit-box; margin: var(--space-2) 0 0 32px; overflow: hidden; color: var(--color-text-muted); font: 12px/var(--line-height-reading) var(--font-mono); -webkit-box-orient: vertical; -webkit-line-clamp: 4; white-space: pre-wrap; word-break: break-word; }
.agent-result.error { color: var(--color-danger); }
.agent-meta { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); margin: var(--space-2) 0 0 32px; color: var(--color-text-faint); font: 500 var(--font-size-xs) var(--font-mono); }
.agent-meta div { display: flex; gap: 4px; }
.agent-meta dt { color: var(--color-text-faint); }
.agent-meta dd { margin: 0; color: var(--color-text-muted); }
</style>
