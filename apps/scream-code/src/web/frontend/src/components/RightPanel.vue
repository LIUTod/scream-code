<script setup lang="ts">
import type { ConnectionStatus } from '../composables/useScreamWebClient';
import type { CreateGoalRequest, GoalSnapshot, LikePreferences, TodoItem, UpdateGoalRequest } from '../types';
import GoalPanel from './GoalPanel.vue';
import TodoPanel from './TodoPanel.vue';
import LikePanel from './LikePanel.vue';

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
}>(), {
  busy: false,
  sessionId: null,
  archived: false,
  goalRequestPending: false,
  goalRequestError: null,
});

const emit = defineEmits<{
  (e: 'insert', text: string): void;
}>();
</script>

<template>
  <aside class="rightbar">
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
@media (max-height:850px) { .panel-section { padding:14px; } }
</style>
