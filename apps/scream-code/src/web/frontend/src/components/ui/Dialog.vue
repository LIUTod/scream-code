<!-- Reusable modal dialog with Teleport. Replaces ad-hoc overlay patterns
     in StatusBar (diff modal) and InfoPanel. -->
<script setup lang="ts">
defineProps<{
  open: boolean;
  title?: string;
  closable?: boolean;
  maxWidth?: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="ui-dialog-overlay" @click.self="closable !== false && emit('close')">
        <div class="ui-dialog" :style="maxWidth ? { maxWidth } : undefined" role="dialog" aria-modal="true">
          <div v-if="title || $slots.header" class="ui-dialog-header">
            <slot name="header">
              <span class="ui-dialog-title">{{ title }}</span>
            </slot>
            <button
              v-if="closable !== false"
              class="ui-dialog-close"
              aria-label="关闭"
              @click="emit('close')"
            >✕</button>
          </div>
          <div class="ui-dialog-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="ui-dialog-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
  padding: var(--space-3);
}
.ui-dialog {
  width: 100%;
  max-width: 480px;
  max-height: 80vh;
  overflow: auto;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl, 0 12px 40px rgba(0, 0, 0, 0.25));
  display: flex;
  flex-direction: column;
}
.ui-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-line);
  flex-shrink: 0;
}
.ui-dialog-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
}
.ui-dialog-close {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-md);
  line-height: 1;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.ui-dialog-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.ui-dialog-body {
  padding: var(--space-2) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.ui-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-line);
  flex-shrink: 0;
}

/* Transition */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-active .ui-dialog,
.dialog-leave-active .ui-dialog {
  transition: transform var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .ui-dialog,
.dialog-leave-to .ui-dialog {
  transform: scale(0.96) translateY(8px);
  opacity: 0;
}
</style>
