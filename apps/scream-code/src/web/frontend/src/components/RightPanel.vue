<script setup lang="ts">
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type { CreateGoalRequest, GoalSnapshot, TodoItem, UpdateGoalRequest } from '../types';
import GoalPanel from './GoalPanel.vue';
import TodoPanel from './TodoPanel.vue';
import SvgIcon from './ui/SvgIcon.vue';

withDefaults(defineProps<{
  busy?: boolean;
  sessionId?: string | null;
  connectionStatus: ConnectionStatus;
  archived?: boolean;
  goal: GoalSnapshot | null;
  todos: TodoItem[];
  goalRequestPending?: boolean;
  goalRequestError?: string | null;
  refineGoal: (description: string) => Promise<string | null>;
  createGoal: (request: CreateGoalRequest) => Promise<boolean>;
  updateGoal: (request: UpdateGoalRequest) => Promise<boolean>;
  pauseGoal: () => Promise<boolean>;
  resumeGoal: () => Promise<boolean>;
  cancelGoal: () => Promise<boolean>;
}>(), {
  busy: false,
  sessionId: null,
  archived: false,
  goalRequestPending: false,
  goalRequestError: null,
});

const emit = defineEmits<{
  (e: 'quick-command', name: string): void;
  (e: 'insert', text: string): void;
}>();

interface QuickTool { icon: string; label: string; hint: string; command?: string; insert?: string }
const primaryTools: readonly QuickTool[] = [
  { icon: 'compact', label: '压缩上下文', hint: '/compact', command: 'compact' },
  { icon: 'brain', label: '切换模型', hint: '/model', command: 'model' },
  { icon: 'clipboard', label: '计划模式', hint: '/plan', command: 'plan' },
  { icon: 'fork', label: '会话分支', hint: '/fork', command: 'fork' },
];
const moreTools: readonly QuickTool[] = [
  { icon: 'message-circle', label: '快速侧问', hint: '/btw', insert: '/btw ' },
  { icon: 'tag', label: '重命名', hint: '/title', insert: '/title ' },
  { icon: 'broom', label: '清空', hint: '/clear', command: 'clear' },
  { icon: 'plus', label: '新会话', hint: '/new', command: 'new' },
];

function activate(tool: QuickTool): void {
  if (tool.command) emit('quick-command', tool.command);
  else if (tool.insert) emit('insert', tool.insert);
}
</script>

<template>
  <aside class="rightbar">
    <section class="panel-section quick-section">
      <div class="section-heading"><div><span>快捷工具</span><small>真实命令入口</small></div><SvgIcon name="command" :size="19" /></div>
      <div class="tool-grid">
        <button v-for="tool in primaryTools" :key="tool.label" class="tool-card" :title="`${tool.label} ${tool.hint}`" @click="activate(tool)">
          <span><SvgIcon :name="tool.icon" :size="22" /></span><strong>{{ tool.label }}</strong><small>{{ tool.hint }}</small>
        </button>
      </div>
      <div class="more-tools">
        <button v-for="tool in moreTools" :key="tool.label" :title="`${tool.label} ${tool.hint}`" @click="activate(tool)"><SvgIcon :name="tool.icon" :size="17" /><span>{{ tool.label }}</span></button>
      </div>
    </section>

    <GoalPanel
      :goal="goal"
      :session-id="sessionId"
      :connection-status="connectionStatus"
      :busy="busy"
      :archived="archived"
      :pending="goalRequestPending"
      :error="goalRequestError"
      :refine-goal="refineGoal"
      :create-goal="createGoal"
      :update-goal="updateGoal"
      :pause-goal="pauseGoal"
      :resume-goal="resumeGoal"
      :cancel-goal="cancelGoal"
    />
    <TodoPanel :todos="todos" />
  </aside>
</template>

<style scoped>
.rightbar { width:var(--rightbar-width); height:100%; overflow-y:auto; overscroll-behavior:contain; display:flex; flex-direction:column; gap:14px; padding:14px 14px 20px; background:var(--color-bg); border-left:1px solid var(--color-line); }
.panel-section { padding:17px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 2px 8px rgba(20,35,24,.03); }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:14px; color:var(--color-accent); }
.section-heading > div { display:flex; flex-direction:column; }
.section-heading span { color:var(--color-text); font-size:14px; font-weight:700; }
.section-heading small { margin-top:4px; color:var(--color-text-faint); font-size:10px; font-weight:400; }
.tool-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
.tool-card { min-height:92px; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:6px; padding:13px; border:1px solid var(--color-line); border-radius:11px; background:var(--color-surface-sunken); color:var(--color-text); cursor:pointer; text-align:left; }
.tool-card > span { width:34px; height:34px; display:grid; place-items:center; border-radius:9px; color:var(--color-accent); background:var(--color-accent-soft); }
.tool-card strong { font-size:12px; }
.tool-card small { color:var(--color-text-faint); font:10px var(--font-mono); }
.tool-card:hover { border-color:var(--color-accent-bd); background:var(--color-accent-soft); transform:translateY(-1px); }
.more-tools { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin-top:9px; }
.more-tools button { height:34px; display:flex; align-items:center; gap:7px; padding:0 9px; border:0; border-radius:8px; background:transparent; color:var(--color-text-muted); font-size:11px; cursor:pointer; }
.more-tools button:hover { color:var(--color-accent); background:var(--color-accent-soft); }
@media (max-height:850px) { .panel-section { padding:14px; } }
</style>
