<!-- Hover tooltip. Replaces title="" attributes for better styling control. -->
<script setup lang="ts">
withDefaults(
  defineProps<{
    text: string;
    position?: 'top' | 'bottom';
  }>(),
  { position: 'top' },
);
</script>

<template>
  <span class="ui-tooltip-wrap">
    <slot />
    <span :class="['ui-tooltip', `ui-tooltip--${position}`]">{{ text }}</span>
  </span>
</template>

<style scoped>
.ui-tooltip-wrap {
  position: relative;
  display: inline-flex;
}
.ui-tooltip {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  padding: var(--space-1) var(--space-2);
  background: var(--color-surface-raised);
  color: var(--color-text);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
  box-shadow: var(--shadow-sm);
  z-index: var(--z-tooltip, 1000);
}
.ui-tooltip--top {
  bottom: 100%;
  margin-bottom: 4px;
}
.ui-tooltip--bottom {
  top: 100%;
  margin-top: 4px;
}
.ui-tooltip-wrap:hover .ui-tooltip {
  opacity: 1;
}
</style>
