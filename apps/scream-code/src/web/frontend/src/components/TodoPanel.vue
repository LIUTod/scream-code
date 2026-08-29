<script setup lang="ts">
import { computed } from 'vue';
import type { TodoItem, TodoStatus } from '../types';
import { groupTodosByPhase } from '../utils/goalTodoState';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{ todos: TodoItem[] }>();

const groups = computed(() => groupTodosByPhase(props.todos));
const completed = computed(() => props.todos.filter((todo) => todo.status === 'done').length);
const inProgress = computed(() => props.todos.filter((todo) => todo.status === 'in_progress').length);
const pending = computed(() => props.todos.filter((todo) => todo.status === 'pending').length);
const percent = computed(() => (props.todos.length ? Math.round((completed.value / props.todos.length) * 100) : 0));
const hint = computed(() => {
  if (!props.todos.length) return '直接来自 Agent 核心状态';
  if (completed.value === props.todos.length) return '全部完成';
  const parts = [];
  if (inProgress.value) parts.push(`进行中 ${inProgress.value}`);
  if (pending.value) parts.push(`待处理 ${pending.value}`);
  return parts.join(' · ') || '直接来自 Agent 核心状态';
});
const statusMeta: Record<TodoStatus, { label: string; symbol: string }> = {
  pending: { label: '待处理', symbol: '○' },
  in_progress: { label: '进行中', symbol: '●' },
  done: { label: '已完成', symbol: '✓' },
};
</script>

<template>
  <section class="todo-panel panel-section">
    <div class="section-heading">
      <span class="head-icon"><SvgIcon name="clipboard" :size="14" /></span>
      <span class="head-title">核心 Todo</span>
      <span class="head-hint">{{ hint }}</span>
      <span class="head-tail"><span class="head-count">{{ completed }}/{{ todos.length }}</span></span>
    </div>

    <div v-if="todos.length === 0" class="panel-body">
      <div class="empty-state">
        <SvgIcon name="check" :size="18" />
        <span>暂无 Todo</span>
        <small>Agent 创建任务清单后会在这里实时显示。</small>
      </div>
    </div>

    <div v-else class="panel-body">
      <div class="progress-row">
        <i class="bar" aria-hidden="true"><i :style="{ width: `${percent}%` }" /></i>
        <span class="progress-value">{{ percent }}%</span>
      </div>

      <section v-for="(group, groupIndex) in groups" :key="group.phase ?? `unphased-${groupIndex}`" class="todo-group">
        <h4>{{ group.phase ?? '未分阶段' }}</h4>
        <ol>
          <li v-for="(todo, index) in group.items" :key="`${groupIndex}-${index}-${todo.title}`" :class="`is-${todo.status}`">
            <span class="status-symbol" :title="statusMeta[todo.status].label">{{ statusMeta[todo.status].symbol }}</span>
            <span class="todo-title">{{ todo.title }}</span>
            <small>{{ statusMeta[todo.status].label }}</small>
          </li>
        </ol>
      </section>
    </div>
  </section>
</template>

<style scoped>
/* Card, header anatomy, count chip and the progress bar come from the shared
   global styles. Items are flat rows with a status rail — no nested boxes. */
.progress-row { display: flex; align-items: center; gap: var(--space-2); }
.progress-row .bar { flex: 1; }
.progress-value {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.empty-state {
  min-height: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  color: var(--color-text-faint);
  text-align: center;
}
.empty-state span { color: var(--color-text-muted); font-size: var(--font-size-xs); font-weight: 650; }
.empty-state small { max-width: 220px; font-size: 10px; line-height: 1.45; }
.todo-group { display: flex; flex-direction: column; gap: var(--space-1); }
.todo-group + .todo-group { margin-top: var(--space-2); }
.todo-group h4 {
  margin: 0;
  color: var(--color-text-faint);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
ol { display: flex; flex-direction: column; gap: 0; margin: 0; padding: 0; list-style: none; }
li {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) 0;
  border-left: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}
li + li { border-top: 1px solid var(--color-line); }
.status-symbol { color: var(--color-text-faint); font: 700 var(--font-size-sm) var(--font-mono); text-align: center; }
.todo-title { overflow-wrap: anywhere; color: var(--color-text); }
li small { color: var(--color-text-faint); font-size: 10px; white-space: nowrap; }
li.is-in_progress { border-left-color: var(--color-accent); }
li.is-in_progress .status-symbol { color: var(--color-accent); animation: breathe var(--dur-breathe) ease-in-out infinite; }
li.is-in_progress small { color: var(--color-accent); }
li.is-done { border-left-color: var(--color-success); }
li.is-done .status-symbol { color: var(--color-success); }
li.is-done .todo-title { color: var(--color-text-faint); text-decoration: line-through; }
@media (prefers-reduced-motion: reduce) { li.is-in_progress .status-symbol { animation: none; } }
</style>
