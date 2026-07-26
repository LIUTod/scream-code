<script setup lang="ts">
import type { SlashCommand } from '../commands';

defineProps<{
  commands: SlashCommand[];
  activeIndex: number;
}>();

const emit = defineEmits<{
  (e: 'select', command: SlashCommand): void;
  (e: 'hover', index: number): void;
}>();
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="斜杠命令">
    <button
      v-for="(cmd, i) in commands"
      :key="cmd.name"
      :class="['slash-item', { active: i === activeIndex }]"
      role="option"
      :aria-selected="i === activeIndex"
      @mousedown.prevent="emit('select', cmd)"
      @mouseenter="emit('hover', i)"
    >
      <span class="slash-name">/{{ cmd.name }}</span>
      <span class="slash-desc">{{ cmd.description }}</span>
      <span v-if="cmd.target === 'backend'" class="slash-badge">服务端</span>
    </button>
    <div class="slash-hint">↑↓ 选择 · Enter/Tab 执行 · Esc 关闭</div>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: var(--space-4);
  right: var(--space-4);
  max-width: 480px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18));
  padding: var(--space-1);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.slash-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  transition: background var(--dur-fast);
}
.slash-item.active,
.slash-item:hover {
  background: var(--color-hover);
}
.slash-name {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--color-accent);
  flex-shrink: 0;
}
.slash-desc {
  flex: 1;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slash-badge {
  font-size: var(--font-size-xs);
  color: var(--color-info);
  border: 1px solid var(--color-info);
  border-radius: var(--radius-full);
  padding: 0 var(--space-2);
  flex-shrink: 0;
}
.slash-hint {
  padding: var(--space-1) var(--space-3) var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
  border-top: 1px solid var(--color-line);
  margin-top: var(--space-1);
}
</style>
