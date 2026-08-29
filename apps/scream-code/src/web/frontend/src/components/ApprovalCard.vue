<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import type { ApprovalRequest } from '../types';
import Button from './ui/Button.vue';

const props = defineProps<{
  approvals: ApprovalRequest[];
}>();

const emit = defineEmits<{
  (e: 'resolve', id: string, decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session'): void;
}>();

const minimized = ref(false);
const feedbackOpen = ref(false);
const feedbackText = ref('');
/** Ids the user just acted on, kept until the server confirms removal. */
const busyIds = ref<Set<string>>(new Set());

const current = computed(() => props.approvals[0]);

// Reset per-request UI state when the current request changes; drop resolved busy flags.
watch(
  () => props.approvals.map((a) => a.id).join(','),
  () => {
    feedbackOpen.value = false;
    feedbackText.value = '';
    const alive = new Set(props.approvals.map((a) => a.id));
    busyIds.value = new Set([...busyIds.value].filter((id) => alive.has(id)));
  },
);

function displayText(a: ApprovalRequest): string {
  if (typeof a.display === 'string') return a.display;
  if (a.display && typeof a.display === 'object' && 'description' in a.display) {
    return String((a.display as { description?: unknown }).description ?? '');
  }
  return a.action ?? '执行该操作';
}

function isBusy(id: string): boolean {
  return busyIds.value.has(id);
}

function act(decision: 'approved' | 'rejected', feedback?: string, scope?: 'once' | 'session') {
  const req = current.value;
  if (!req || isBusy(req.id)) return;
  busyIds.value = new Set([...busyIds.value, req.id]);
  emit('resolve', req.id, decision, feedback, scope);
}

function submitFeedback() {
  const text = feedbackText.value.trim();
  if (!text) return;
  act('rejected', text);
}

function onKeydown(e: KeyboardEvent) {
  const req = current.value;
  if (!req || minimized.value) return;
  const target = e.target as HTMLElement | null;
  const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
  if (inField) {
    // Inside the feedback box, Enter submits; other keys type normally.
    if (feedbackOpen.value && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFeedback();
    }
    return;
  }
  switch (e.key) {
    case '1':
      e.preventDefault();
      act('approved', undefined, 'once');
      break;
    case '2':
      e.preventDefault();
      act('approved', undefined, 'session');
      break;
    case '3':
      e.preventDefault();
      act('rejected');
      break;
    case '4':
      e.preventDefault();
      feedbackOpen.value = !feedbackOpen.value;
      break;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="approvals.length" class="approval-card">
    <button v-if="minimized" class="approval-minibar" @click="minimized = false">
      ⚠ {{ approvals.length }} 个待审批请求 — 点击展开
    </button>

    <template v-else-if="current">
      <div class="approval-header">
        <span class="approval-icon">⚠</span>
        <span class="approval-title">
          <span class="tool-name">{{ current.toolName }}</span>
          <span class="action-summary">{{ displayText(current) }}</span>
        </span>
        <span v-if="approvals.length > 1" class="approval-count">+{{ approvals.length - 1 }}</span>
        <button class="icon-btn" title="最小化" aria-label="最小化" @click="minimized = true">—</button>
      </div>

      <pre class="approval-action">{{ displayText(current) }}</pre>

      <div v-if="feedbackOpen" class="feedback-area">
        <textarea
          v-model="feedbackText"
          class="feedback-input"
          rows="2"
          name="approval-feedback"
          aria-label="拒绝反馈"
          placeholder="输入反馈，Enter 提交（将作为拒绝原因反馈给 Agent）"
        />
      </div>

      <div class="approval-buttons">
        <Button
          variant="primary"
          :disabled="isBusy(current.id)"
          @click="act('approved', undefined, 'once')"
        >
          <kbd>1</kbd> 批准
        </Button>
        <Button
          variant="secondary"
          :disabled="isBusy(current.id)"
          @click="act('approved', undefined, 'session')"
        >
          <kbd>2</kbd> 会话批准
        </Button>
        <Button
          variant="danger"
          :disabled="isBusy(current.id)"
          @click="act('rejected')"
        >
          <kbd>3</kbd> 拒绝
        </Button>
        <Button
          variant="secondary"
          :class="{ 'feedback-active': feedbackOpen }"
          :disabled="isBusy(current.id)"
          @click="feedbackOpen = !feedbackOpen"
        >
          <kbd>4</kbd> 反馈
        </Button>
        <span v-if="isBusy(current.id)" class="busy-indicator" aria-label="处理中">
          <span class="spinner" /> 处理中…
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.approval-card {
  border: 1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-line));
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-md);
  overflow: hidden;
  animation: rise-in var(--dur-msg-assistant) var(--ease-out) both;
}
@media (prefers-reduced-motion: reduce) {
  .approval-card { animation: none; }
}

.approval-minibar {
  width: 100%;
  min-height: 44px;
  padding: var(--space-2) var(--space-4);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border: none;
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.approval-minibar:hover { background: var(--color-hover); }
.approval-minibar:active { background: var(--color-selected); }

.approval-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-warning-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--color-warning) 25%, var(--color-line));
}
.approval-icon {
  color: var(--color-warning);
  flex-shrink: 0;
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .approval-icon { animation: none; }
}
.approval-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.tool-name {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  flex-shrink: 0;
}
.action-summary {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.approval-count {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  font-weight: 700;
  color: var(--color-warning);
  background: var(--color-warning-soft);
  border: 1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-line));
  border-radius: var(--radius-full);
  padding: 0 var(--space-2);
}
.icon-btn {
  flex-shrink: 0;
  min-height: 44px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.icon-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.icon-btn:active {
  background: var(--color-selected);
}

.approval-action {
  margin: var(--space-3);
  margin-bottom: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.feedback-area {
  padding: var(--space-2) var(--space-3) 0;
}
.feedback-input {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--font-size-sm);
  resize: vertical;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.feedback-input:focus {
  outline: none;
  border-color: var(--color-warning);
  box-shadow: var(--glow-focus);
}

.approval-buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  flex-wrap: wrap;
}
.approval-buttons kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xs);
  padding: 0 var(--space-1);
  margin-right: var(--space-1);
}
/* 批准主按钮：渐变 + 光晕（安全关键操作，需被注意到） */
.approval-buttons :deep(.ui-btn--primary) {
  background: var(--gradient-accent);
  color: var(--color-on-accent);
  border-color: transparent;
  box-shadow: var(--glow-accent);
}
.approval-buttons :deep(.ui-btn--primary:not(:disabled):hover) {
  filter: brightness(1.06);
}
.approval-buttons :deep(.ui-btn--primary:not(:disabled):active) {
  filter: brightness(0.96);
  transform: translateY(1px);
}
.approval-buttons :deep(.ui-btn--primary kbd) {
  background: rgba(0, 0, 0, 0.15);
  border-color: transparent;
}
/* 拒绝按钮：danger 语义描边样式 */
.approval-buttons :deep(.ui-btn--danger) {
  background: transparent;
  color: var(--color-danger);
  border: 1px solid var(--color-danger);
}
.approval-buttons :deep(.ui-btn--danger:not(:disabled):hover) {
  background: var(--color-danger-soft);
}
.approval-buttons :deep(.ui-btn--danger:not(:disabled):active) {
  background: color-mix(in srgb, var(--color-danger-soft) 60%, var(--color-danger) 12%);
  transform: translateY(1px);
}
.feedback-active {
  border-color: var(--color-warning) !important;
  background: var(--color-warning-soft) !important;
}

.busy-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-line-strong);
  border-top-color: var(--color-warning);
  border-radius: var(--radius-full);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 1.6s; }
}
</style>
