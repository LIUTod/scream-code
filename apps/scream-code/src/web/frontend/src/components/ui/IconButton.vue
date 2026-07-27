<!-- Compact icon-only button for toolbars and inline actions.
     Replaces .icon-btn in SessionSidebar, .meta-btn in MessageItem, etc. -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    variant?: 'default' | 'danger';
    size?: 'sm' | 'md';
    disabled?: boolean;
  }>(),
  { variant: 'default', size: 'sm', disabled: false },
);
</script>

<template>
  <button
    class="ui-icon-btn"
    :class="[`ui-icon-btn--${variant}`, `ui-icon-btn--${size}`]"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
    type="button"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  line-height: 1;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.ui-icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}
.ui-icon-btn:not(:disabled):active {
  transform: scale(0.9);
}
.ui-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Sizes */
.ui-icon-btn--sm {
  padding: var(--space-1);
  font-size: var(--font-size-sm);
}
.ui-icon-btn--md {
  padding: var(--space-2);
  font-size: var(--font-size-base);
}

/* Variants */
.ui-icon-btn--default:not(:disabled):hover {
  background: var(--color-hover);
}
.ui-icon-btn--danger:not(:disabled):hover {
  background: var(--color-danger-soft);
}
</style>
