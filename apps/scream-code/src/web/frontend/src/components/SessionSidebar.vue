<script setup lang="ts">
import type { SessionListItem } from '../types';

defineProps<{
  sessions: SessionListItem[];
  currentSessionId: string | null;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'switch', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'export', id: string): void;
}>();

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-brand">Scream</span>
      <button class="new-session-btn" title="新建会话" @click="emit('create')">
        <span class="plus">+</span> 新建会话
      </button>
    </div>
    <div class="session-list">
      <TransitionGroup name="session">
        <div
          v-for="s in sessions"
          :key="s.sessionId"
          :class="['session-item', { active: s.sessionId === currentSessionId }]"
          @click="emit('switch', s.sessionId)"
        >
          <div class="session-info">
            <div class="session-title">{{ s.title || 'New Session' }}</div>
            <div class="session-meta">
              <span>{{ formatTime(s.createdAt) }}</span>
              <span>{{ s.messageCount }} 条</span>
              <span v-if="s.active" class="active-dot" title="活跃">●</span>
            </div>
          </div>
          <div class="session-actions" @click.stop>
            <button class="icon-btn" title="导出 Markdown" @click="emit('export', s.sessionId)">📥</button>
            <button class="icon-btn danger" title="删除" @click="emit('delete', s.sessionId)">🗑</button>
          </div>
        </div>
      </TransitionGroup>
      <div v-if="sessions.length === 0" class="empty-sessions">
        <div class="empty-icon">💬</div>
        <div>暂无会话</div>
        <div class="empty-hint">点击上方按钮开始新会话</div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface-sunken);
  border-right: 1px solid var(--color-line);
}
.sidebar-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.sidebar-brand {
  font-size: var(--font-size-sm);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.new-session-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.new-session-btn:hover {
  background: var(--color-accent-hover);
}
.new-session-btn:active {
  transform: scale(0.98);
}
.plus {
  font-size: var(--font-size-base);
  line-height: 1;
}
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
}
.session-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  cursor: pointer;
  margin-bottom: var(--space-1);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.session-item:hover {
  background: var(--color-hover);
}
.session-item.active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent-bd);
}
.session-info {
  flex: 1;
  min-width: 0;
}
.session-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-meta {
  display: flex;
  gap: var(--space-2);
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.active-dot {
  color: var(--color-accent);
}
.session-actions {
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.session-item:hover .session-actions,
.session-item.active .session-actions {
  opacity: 1;
}
.icon-btn {
  background: transparent;
  border: none;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--font-size-sm);
  line-height: 1;
  transition: background var(--dur-fast) var(--ease-out);
}
.icon-btn:hover {
  background: var(--color-hover);
}
.icon-btn.danger:hover {
  background: var(--color-danger-soft);
}
.empty-sessions {
  padding: var(--space-6) var(--space-3);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.empty-icon {
  font-size: var(--font-size-2xl);
  margin-bottom: var(--space-2);
  opacity: 0.5;
}
.empty-hint {
  margin-top: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}

/* List transition */
.session-enter-active,
.session-leave-active {
  transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out);
}
.session-enter-from,
.session-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

@media (max-width: 768px) {
  .sidebar {
    width: 200px;
  }
}
@media (max-width: 640px) {
  .sidebar {
    display: none;
  }
}
</style>
