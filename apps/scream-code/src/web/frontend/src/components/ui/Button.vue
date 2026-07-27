<!-- Reusable button with semantic variants. Replaces ad-hoc .btn classes
     scattered across Composer, ApprovalCard, SessionSidebar, etc. -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'danger' | 'ghost' | 'secondary';
    size?: 'sm' | 'md';
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  { variant: 'primary', size: 'md', type: 'button' },
);
</script>

<template>
  <button
    class="ui-btn"
    :class="[`ui-btn--${variant}`, `ui-btn--${size}`]"
    :type="type"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-family: inherit;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    filter var(--dur-fast) var(--ease-out);
}
.ui-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}
.ui-btn:not(:disabled):active {
  transform: scale(0.97);
}
.ui-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Sizes */
.ui-btn--sm {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  border-radius: var(--radius-sm);
}
.ui-btn--md {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
}

/* Variants */
.ui-btn--primary {
  background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%);
  color: var(--color-on-accent);
  border-color: var(--color-accent);
  box-shadow: var(--shadow-xs);
}
.ui-btn--primary:not(:disabled):hover {
  filter: brightness(1.08);
  box-shadow: var(--shadow-sm), 0 0 12px var(--color-accent-glow);
}

.ui-btn--danger {
  background: var(--color-danger);
  color: #fff;
  border-color: var(--color-danger);
  box-shadow: var(--shadow-xs);
}
.ui-btn--danger:not(:disabled):hover {
  filter: brightness(1.1);
}

.ui-btn--secondary {
  background: var(--color-surface);
  color: var(--color-text);
  border-color: var(--color-line);
}
.ui-btn--secondary:not(:disabled):hover {
  border-color: var(--color-line-strong);
  background: var(--color-surface-raised);
}

.ui-btn--ghost {
  background: transparent;
  color: var(--color-text-muted);
  border-color: transparent;
}
.ui-btn--ghost:not(:disabled):hover {
  background: var(--color-hover);
  color: var(--color-text);
}
</style>
