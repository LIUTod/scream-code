<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import type { ApprovalRequest } from '../types';

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
          placeholder="输入反馈，Enter 提交（将作为拒绝原因反馈给 Agent）"
        />
      </div>

      <div class="approval-buttons">
        <button
          class="btn btn-approve"
          :disabled="isBusy(current.id)"
          @click="act('approved', undefined, 'once')"
        >
          <kbd>1</kbd> 批准
        </button>
        <button
          class="btn btn-session"
          :disabled="isBusy(current.id)"
          @click="act('approved', undefined, 'session')"
        >
          <kbd>2</kbd> 会话批准
        </button>
        <button
          class="btn btn-reject"
          :disabled="isBusy(current.id)"
          @click="act('rejected')"
        >
          <kbd>3</kbd> 拒绝
        </button>
        <button
          :class="['btn btn-feedback', { active: feedbackOpen }]"
          :disabled="isBusy(current.id)"
          @click="feedbackOpen = !feedbackOpen"
        >
          <kbd>4</kbd> 反馈
        </button>
        <span v-if="isBusy(current.id)" class="busy-indicator" aria-label="处理中">
          <span class="spinner" /> 处理中…
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.approval-card {
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-md);
  overflow: hidden;
}

.approval-minibar {
  width: 100%;
  padding: var(--space-2) var(--space-4);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border: none;
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.approval-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-warning-soft);
}
.approval-icon {
  color: var(--color-warning);
  flex-shrink: 0;
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
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-full);
  padding: 0 var(--space-2);
}
.icon-btn {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}
.icon-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
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
}
.feedback-input:focus {
  outline: none;
  border-color: var(--color-warning);
}

.approval-buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  flex-wrap: wrap;
}
.btn {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  background: var(--color-surface);
  color: var(--color-text);
  transition:
    background var(--dur-fast),
    border-color var(--dur-fast),
    opacity var(--dur-fast),
    transform var(--dur-fast) var(--ease-out);
}
.btn:active:not(:disabled) {
  transform: scale(0.97);
}
.btn kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xs);
  padding: 0 var(--space-1);
  margin-right: var(--space-1);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-approve {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
}
.btn-approve kbd {
  background: rgba(0, 0, 0, 0.15);
  border-color: transparent;
}
.btn-approve:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
.btn-session:hover:not(:disabled) {
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
}
.btn-reject:hover:not(:disabled) {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.btn-feedback.active,
.btn-feedback:hover:not(:disabled) {
  border-color: var(--color-warning);
  background: var(--color-warning-soft);
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
</style>
