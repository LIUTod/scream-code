<!-- Toast notification container. Mounted once in App.vue.
     Replaces transient system messages that were lost in chat flow. -->
<script setup lang="ts">
import { useToast } from '../../composables/useToast';

const { toasts, removeToast } = useToast();

const icons: Record<string, string> = {
  info: 'ℹ',
  success: '✓',
  error: '✗',
  warning: '⚠',
};
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          :class="['toast', `toast--${t.type}`]"
          @click="removeToast(t.id)"
        >
          <span class="toast-icon">{{ icons[t.type] }}</span>
          <span class="toast-msg">{{ t.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: var(--space-5);
  right: var(--space-5);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-line);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xl);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  cursor: pointer;
  pointer-events: auto;
  max-width: min(380px, calc(100vw - 32px));
  animation: rise-in var(--dur-slower) var(--ease-spring);
}
.toast-icon {
  flex-shrink: 0;
  font-weight: 700;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  font-size: 11px;
}
.toast--info .toast-icon { background: var(--color-accent-soft); color: var(--color-accent); }
.toast--success .toast-icon { background: var(--color-success-soft); color: var(--color-success); }
.toast--error .toast-icon { background: var(--color-danger-soft); color: var(--color-danger); }
.toast--warning .toast-icon { background: var(--color-warning-soft); color: var(--color-warning); }
.toast--error { border-color: var(--color-danger); }

/* Transition */
.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur-slower) var(--ease-spring), transform var(--dur-slower) var(--ease-spring);
}
.toast-enter-from { opacity: 0; transform: translateY(6px); }
.toast-leave-to { opacity: 0; transform: translateY(6px); }
</style>
