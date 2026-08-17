<script setup lang="ts">
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type { CreateGoalRequest, GitStatus, GoalSnapshot, LikePreferences, SessionStatus, TodoItem, UpdateGoalRequest } from '../types';
import GitPanel from './GitPanel.vue';
import GoalPanel from './GoalPanel.vue';
import LikePanel from './LikePanel.vue';
import RunStatusPanel from './RunStatusPanel.vue';
import TodoPanel from './TodoPanel.vue';
import SvgIcon from './ui/SvgIcon.vue';

withDefaults(defineProps<{
  busy?: boolean;
  sessionId?: string | null;
  connectionStatus: ConnectionStatus;
  archived?: boolean;
  goal: GoalSnapshot | null;
  todos: TodoItem[];
  like: LikePreferences;
  updateLike: (prefs: LikePreferences) => Promise<boolean>;
  goalRequestPending?: boolean;
  goalRequestError?: string | null;
  refineGoal: (description: string) => Promise<string | null>;
  createGoal: (request: CreateGoalRequest) => Promise<boolean>;
  updateGoal: (request: UpdateGoalRequest) => Promise<boolean>;
  pauseGoal: () => Promise<boolean>;
  resumeGoal: () => Promise<boolean>;
  cancelGoal: () => Promise<boolean>;
  status?: SessionStatus;
  gitStatus?: GitStatus | null;
}>(), {
  busy: false,
  sessionId: null,
  archived: false,
  goalRequestPending: false,
  goalRequestError: null,
  status: undefined,
  gitStatus: null,
});

const emit = defineEmits<{
  (e: 'insert', text: string): void;
  (e: 'refresh-git'): void;
  (e: 'toggle'): void;
}>();
</script>

<template>
  <aside class="rightbar">
    <div class="rightbar-toolbar">
      <button class="collapse-btn" title="收起面板" aria-label="收起右侧面板" @click="emit('toggle')">
        <SvgIcon name="panel-right" :size="18" />
      </button>
    </div>
    <RunStatusPanel :status="status ?? ({} as SessionStatus)" :busy="busy" :connection-status="connectionStatus" />
    <GitPanel :git-status="gitStatus" @refresh="emit('refresh-git')" />
    <TodoPanel :todos="todos" />
    <LikePanel :like="like" :update-like="updateLike" />
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
  </aside>
</template>

<style scoped>
.rightbar { width:var(--rightbar-width); height:100%; overflow-y:auto; overscroll-behavior:contain; display:flex; flex-direction:column; gap:14px; padding:14px 14px 20px; background:var(--color-bg); border-left:1px solid var(--color-line); }
.rightbar-toolbar { display:flex; justify-content:flex-end; }
.collapse-btn {
  width:30px; height:30px; display:grid; place-items:center;
  border:0; border-radius:8px; background:transparent; color:var(--color-text-faint); cursor:pointer;
}
.collapse-btn:hover { color:var(--color-accent); background:var(--color-accent-soft); }
@media (max-height:850px) { .panel-section { padding:14px; } }
</style>
