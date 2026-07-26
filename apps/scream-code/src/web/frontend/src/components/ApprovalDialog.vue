<script setup lang="ts">
import type { ApprovalRequest } from '../types';

const props = defineProps<{
  approvals: ApprovalRequest[];
}>();

const emit = defineEmits<{
  (e: 'resolve', id: string, decision: 'approved' | 'rejected'): void;
}>();

function displayText(a: ApprovalRequest): string {
  if (typeof a.display === 'string') return a.display;
  if (a.display && typeof a.display === 'object' && 'description' in a.display) {
    return String((a.display as { description?: unknown }).description ?? '');
  }
  return a.action ?? '执行该操作';
}
</script>

<template>
  <div v-if="approvals.length" class="approval-overlay">
    <div class="approval-box">
      <h3>🔧 {{ approvals[0].toolName }} 请求批准</h3>
      <pre class="approval-action">{{ displayText(approvals[0]) }}</pre>
      <div class="approval-count" v-if="approvals.length > 1">还有 {{ approvals.length - 1 }} 个待审批请求</div>
      <div class="approval-buttons">
        <button class="btn btn-secondary" @click="emit('resolve', approvals[0].id, 'rejected')">拒绝</button>
        <button class="btn btn-primary" @click="emit('resolve', approvals[0].id, 'approved')">批准</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.approval-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}
.approval-box {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  max-width: 520px;
  width: 100%;
}
.approval-box h3 {
  margin-bottom: 12px;
  font-size: 16px;
}
.approval-action {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  font-family: "SF Mono", "Cascadia Code", monospace;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}
.approval-count {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-dim);
}
.approval-buttons {
  display: flex;
  gap: 12px;
  margin-top: 20px;
}
.btn {
  flex: 1;
  border: none;
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary {
  background: var(--accent);
  color: #000;
}
.btn-secondary {
  background: var(--border);
  color: var(--text);
}
</style>
