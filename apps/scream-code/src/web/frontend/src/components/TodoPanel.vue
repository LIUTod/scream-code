<script setup lang="ts">
import { computed } from 'vue';
import type { TodoItem, TodoStatus } from '../types';
import { groupTodosByPhase } from '../utils/goalTodoState';
import SvgIcon from './ui/SvgIcon.vue';

const props = defineProps<{ todos: TodoItem[] }>();

const groups = computed(() => groupTodosByPhase(props.todos));
const completed = computed(() => props.todos.filter((todo) => todo.status === 'done').length);
const statusMeta: Record<TodoStatus, { label: string; symbol: string }> = {
  pending: { label: '待处理', symbol: '○' },
  in_progress: { label: '进行中', symbol: '●' },
  done: { label: '已完成', symbol: '✓' },
};
</script>

<template>
  <section class="todo-panel panel-section">
    <div class="section-heading">
      <div><span>核心 Todo</span><small>直接来自 Agent 核心状态</small></div>
      <span class="count-pill">{{ completed }}/{{ todos.length }}</span>
    </div>

    <div v-if="todos.length === 0" class="empty-state">
      <SvgIcon name="check" :size="18" />
      <span>暂无 Todo</span>
      <small>Agent 创建任务清单后会在这里实时显示。</small>
    </div>

    <div v-else class="todo-groups">
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
.panel-section { padding:17px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 2px 8px rgba(20,35,24,.03); }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:14px; }
.section-heading > div { display:flex; flex-direction:column; }
.section-heading span { color:var(--color-text); font-size:14px; font-weight:700; }
.section-heading small { margin-top:4px; color:var(--color-text-faint); font-size:10px; font-weight:400; }
.count-pill { min-width:38px; padding:5px 8px; border-radius:999px; color:var(--color-success)!important; background:var(--color-success-soft); font:700 10px var(--font-mono)!important; text-align:center; }
.empty-state { min-height:88px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; padding:12px; border:1px dashed var(--color-line); border-radius:10px; color:var(--color-text-faint); text-align:center; }
.empty-state span { color:var(--color-text-muted); font-size:11px; font-weight:650; }
.empty-state small { max-width:220px; font-size:9px; line-height:1.45; }
.todo-groups { display:grid; gap:13px; }
.todo-group h4 { margin:0 0 6px; color:var(--color-text-faint); font-size:9px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
ol { display:grid; gap:4px; margin:0; padding:0; list-style:none; }
li { display:grid; grid-template-columns:17px minmax(0,1fr) auto; align-items:start; gap:7px; padding:7px 8px; border-radius:8px; color:var(--color-text-muted); background:var(--color-surface-sunken); font-size:10px; line-height:1.45; }
.status-symbol { color:var(--color-text-faint); font:700 12px var(--font-mono); text-align:center; }
.todo-title { overflow-wrap:anywhere; }
li small { padding-top:1px; color:var(--color-text-faint); font-size:8px; white-space:nowrap; }
li.is-in_progress { color:var(--color-text); background:var(--color-accent-soft); }
li.is-in_progress .status-symbol,li.is-in_progress small { color:var(--color-accent); }
li.is-done .status-symbol { color:var(--color-success); }
li.is-done .todo-title { color:var(--color-text-faint); text-decoration:line-through; }
@media (max-height:850px) { .panel-section { padding:14px; } }
</style>
