<!-- Visual drag handle for resizable panels. -->
<script setup lang="ts">
defineProps<{
  dragging?: boolean;
}>();
</script>

<template>
  <div
    class="resize-handle"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    aria-label="拖拽调整宽度"
  />
</template>

<style scoped>
.resize-handle {
  flex-shrink: 0;
  width: 4px;
  margin-left: -2px;
  margin-right: -2px;
  cursor: col-resize;
  position: relative;
  z-index: 5;
  transition: background var(--dur-fast);
}
.resize-handle:hover,
.resize-handle.dragging {
  background: var(--color-accent);
  opacity: 0.6;
}
</style>
