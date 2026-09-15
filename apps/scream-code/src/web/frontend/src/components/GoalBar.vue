<script setup lang="ts">
import { computed } from 'vue';
import type { GoalSnapshot } from '../types';
import SvgIcon from './ui/SvgIcon.vue';

/**
 * One-line Goal bar in the takeover area (L2).
 *
 * It only presents state and starts actions; it does not carry the Goal edit form
 * — that logic (budget validation, AI optimisation, save/cancel confirmation)
 * already lives in full in GoalPanel, and this bar reaches the same set of client
 * channels (pauseGoal / resumeGoal / cancelGoal) and the right-dock Goal tab
 * through its host, so there is no second Goal implementation. "Edit" expands the
 * right dock onto the Goal tab: a reuse entry point, not a rewrite.
 *
 * Presentation discipline: only the three in-flight states (active/paused/blocked)
 * appear above the composer; complete is left to GoalPanel's wrap-up view and does
 * not persist here.
 */
const props = withDefaults(
  defineProps<{
    goal: GoalSnapshot | null;
    /** Disables the actions when the session is not writable (disconnected / no session / request in flight). */
    disabled?: boolean;
    disabledReason?: string;
    busy?: boolean;
    pending?: boolean;
  }>(),
  { disabled: false, disabledReason: '', busy: false, pending: false },
);

const emit = defineEmits<{
  (e: 'pause'): void;
  (e: 'resume'): void;
  (e: 'cancel'): void;
  (e: 'edit'): void;
}>();

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
};

const visible = computed(() => !!props.goal && props.goal.status !== 'complete');
const running = computed(() => props.goal?.status === 'active');
const statusLabel = computed(() => STATUS_LABEL[props.goal?.status ?? ''] ?? '目标');
const actionReason = computed(() =>
  props.disabled ? props.disabledReason || '当前不可操作' : '',
);
const metric = computed(() => {
  const goal = props.goal;
  if (!goal) return '';
  const budget = goal.budget?.turnBudget;
  return budget ? `${goal.turnsUsed}/${budget} 轮` : `${goal.turnsUsed} 轮`;
});
</script>

<template>
  <div v-if="visible && goal" class="goal-bar" data-goal-bar :data-goal-status="goal.status">
    <SvgIcon name="target" :size="14" class="goal-icon" />
    <span class="goal-status">{{ statusLabel }}</span>
    <span class="goal-objective" :title="goal.objective">{{ goal.objective }}</span>
    <span class="goal-metric" title="已用轮次">{{ metric }}</span>
    <div class="goal-actions">
      <button
        class="goal-action"
        type="button"
        title="编辑目标与预算（在右栏 Goal 面板）"
        aria-label="编辑目标"
        @click="emit('edit')"
      >
        <SvgIcon name="edit" :size="13" />
        <span>编辑</span>
      </button>
      <button
        v-if="running"
        class="goal-action"
        type="button"
        :disabled="disabled || busy || pending"
        :title="disabled || pending ? actionReason : '暂停目标执行'"
        aria-label="暂停目标"
        @click="emit('pause')"
      >
        <span>暂停</span>
      </button>
      <button
        v-else
        class="goal-action"
        type="button"
        :disabled="disabled || busy || pending"
        :title="disabled || pending ? actionReason : '继续目标执行'"
        aria-label="继续目标"
        @click="emit('resume')"
      >
        <span>继续</span>
      </button>
      <button
        class="goal-action is-danger"
        type="button"
        :disabled="disabled || pending"
        :title="disabled ? actionReason : '取消目标（可在右栏 Goal 面板查看结果）'"
        aria-label="取消目标"
        @click="emit('cancel')"
      >
        清除
      </button>
    </div>
  </div>
</template>

<style scoped>
/* One-line: a low-contrast bar as wide as the composer, using a left colour band
   to say "this session is taken over by a goal"; no extra border — the composer
   card is already one. */
.goal-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
[data-goal-status='paused'] .goal-bar,
[data-goal-status='blocked'] .goal-bar {
  background: var(--color-hover);
}
.goal-icon {
  flex-shrink: 0;
  color: var(--color-accent);
}
.goal-status {
  flex-shrink: 0;
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-weight: 600;
  white-space: nowrap;
}
.goal-objective {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.goal-metric {
  flex-shrink: 0;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}
.goal-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.goal-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.goal-action:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-text);
}
.goal-action:disabled {
  color: var(--color-text-faint);
  cursor: default;
}
.goal-action.is-danger {
  color: var(--color-danger);
}
.goal-action.is-danger:hover:not(:disabled) {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

@media (max-width: 640px) {
  .goal-metric {
    display: none;
  }
}
</style>
