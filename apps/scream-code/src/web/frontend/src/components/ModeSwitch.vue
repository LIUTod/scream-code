<script setup lang="ts">
export type WorkspaceMode = 'chat' | 'goal';

withDefaults(defineProps<{ modelValue: WorkspaceMode }>(), { modelValue: 'chat' });

const emit = defineEmits<{ (e: 'update:modelValue', mode: WorkspaceMode): void }>();

const MODES: { id: WorkspaceMode; label: string }[] = [
  { id: 'chat', label: '智能工作' },
  { id: 'goal', label: '任务模式' },
];
</script>

<template>
  <div class="mode-switch" role="tablist" aria-label="对话模式">
    <button
      v-for="m in MODES"
      :key="m.id"
      role="tab"
      :aria-selected="modelValue === m.id"
      :class="['mode-pill', { active: modelValue === m.id }]"
      @click="emit('update:modelValue', m.id)"
    >
      {{ m.label }}
    </button>
  </div>
</template>

<style scoped>
/* No outer box: a segmented control inside another bordered pill is the
   "框中框" pattern. The group is transparent; only the selected tab has a fill. */
.mode-switch {
  display: inline-flex;
  gap: var(--space-1);
  padding: 0;
  border-radius: 0;
  background: transparent;
  border: 0;
}
.mode-pill {
  min-height: 32px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.mode-pill:hover:not(.active) {
  color: var(--color-text);
  background: var(--color-hover);
}
.mode-pill.active {
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: 600;
  box-shadow: var(--shadow-xs);
}
@media (max-width: 640px) {
  .mode-pill {
    min-height: 40px;
  }
}
</style>
