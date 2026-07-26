<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ToolMessage } from '../types';

const props = withDefaults(
  defineProps<{
    tool: ToolMessage;
    /** True while the parent turn is still streaming thinking deltas. */
    active?: boolean;
  }>(),
  { active: false },
);

const panelOpen = ref(false);
const streamRef = ref<HTMLElement | null>(null);

const text = computed(() => props.tool.output ?? '');

/** Teaser: last non-empty paragraph, shown faded once the turn ends. */
const teaser = computed(() => {
  const paragraphs = text.value.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.at(-1) ?? '';
});

// Keep the streaming window pinned to the bottom while new deltas arrive.
watch(text, () => {
  if (!props.active) return;
  nextTick(() => {
    const el = streamRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});

function openPanel() {
  panelOpen.value = true;
}

function closePanel() {
  panelOpen.value = false;
}
</script>

<template>
  <div class="thinking-block">
    <button
      v-if="!active"
      class="thinking-teaser"
      title="点击查看完整思考过程"
      @click="openPanel"
    >
      <span class="teaser-icon">💭</span>
      <span class="teaser-text">{{ teaser || '思考过程' }}</span>
      <span class="teaser-open">展开</span>
    </button>

    <div v-else class="thinking-stream">
      <div class="stream-header">
        <span class="stream-icon">💭</span>
        <span class="stream-title">思考中…</span>
        <span class="stream-dot" />
      </div>
      <div ref="streamRef" class="stream-body">{{ text }}</div>
    </div>

    <Teleport to="body">
      <div v-if="panelOpen" class="thinking-overlay" @click.self="closePanel">
        <aside class="thinking-panel" role="dialog" aria-label="思考过程">
          <header class="panel-header">
            <span>💭 思考过程</span>
            <button class="panel-close" aria-label="关闭" @click="closePanel">✕</button>
          </header>
          <div class="panel-body">{{ text || '(空)' }}</div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.thinking-block {
  width: 100%;
  margin-top: var(--space-2);
  font-weight: 425;
  animation: think-in var(--dur-msg-assistant) var(--ease-out) both;
}
@keyframes think-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .thinking-block {
    animation: none;
  }
}

/* Collapsed teaser */
.thinking-teaser {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--color-text-faint);
  font-size: var(--font-size-sm);
  text-align: left;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.thinking-teaser:hover {
  background: var(--color-hover);
  color: var(--color-text-muted);
}
.teaser-icon {
  flex-shrink: 0;
}
.teaser-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  mask-image: linear-gradient(to right, #000 70%, transparent);
  -webkit-mask-image: linear-gradient(to right, #000 70%, transparent);
}
.teaser-open {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}

/* Streaming window (≈5 lines) */
.thinking-stream {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  overflow: hidden;
}
.stream-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: var(--color-surface-raised);
}
.stream-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: think-pulse 1.2s var(--ease-out) infinite;
}
@keyframes think-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.stream-body {
  max-height: calc(5 * 1.6 * var(--font-size-sm));
  overflow-y: auto;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Side panel */
.thinking-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: var(--z-modal);
  display: flex;
  justify-content: flex-end;
}
.thinking-panel {
  width: min(440px, 92vw);
  height: 100%;
  background: var(--color-surface-raised);
  border-left: 1px solid var(--color-line);
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
  animation: slide-in var(--dur-slow) var(--ease-out);
}
@keyframes slide-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-line);
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
}
.panel-close {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-base);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
}
.panel-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: 425;
  line-height: 1.7;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
