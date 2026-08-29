<!-- Reusable modal dialog with Teleport. Replaces ad-hoc overlay patterns
     in TopBar (diff modal) and InfoPanel. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    closable?: boolean;
    maxWidth?: string;
  }>(),
  { title: undefined, closable: true, maxWidth: undefined },
);

const emit = defineEmits<{ (e: 'close'): void }>();

const dialogRef = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  const root = dialogRef.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape' && props.closable !== false) {
    e.stopPropagation();
    emit('close');
    return;
  }
  if (e.key !== 'Tab') return;
  // Focus trap: keep Tab cycling inside the dialog while it is open.
  const items = focusables();
  if (items.length === 0) {
    e.preventDefault();
    dialogRef.value?.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !dialogRef.value?.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !dialogRef.value?.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void nextTick(() => {
        const target = focusables()[0] ?? dialogRef.value;
        target?.focus();
      });
    } else if (previouslyFocused) {
      previouslyFocused.focus();
      previouslyFocused = null;
    }
  },
  { immediate: false },
);

onMounted(() => window.addEventListener('keydown', onGlobalKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown, true));
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="ui-dialog-overlay" @click.self="closable !== false && emit('close')">
        <div ref="dialogRef" class="ui-dialog" :style="maxWidth ? { maxWidth } : undefined" role="dialog" aria-modal="true" tabindex="-1">
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
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-overlay);
  padding: var(--space-4);
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
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.ui-dialog-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.ui-dialog-close:not(:disabled):active {
  transform: scale(0.9);
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

/* Transition: entrance = rise-in (slower + spring); exit = quiet fade.
   Mirrors the global rise-in primitive: opacity 0→1 + translateY(6px)→0. */
.dialog-enter-active {
  transition: opacity var(--dur-slower) var(--ease-spring);
}
.dialog-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-active .ui-dialog {
  transition: transform var(--dur-slower) var(--ease-spring), opacity var(--dur-slower) var(--ease-spring);
}
.dialog-leave-active .ui-dialog {
  transition: transform var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .ui-dialog,
.dialog-leave-to .ui-dialog {
  transform: translateY(6px);
  opacity: 0;
}
</style>
