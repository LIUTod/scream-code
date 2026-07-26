<script setup lang="ts">
import type { SessionListItem } from '../types';

const props = defineProps<{
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
    <button class="new-session-btn" @click="emit('create')">
      + 新建会话
    </button>
    <div class="session-list">
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
            <span v-if="s.active" class="active-dot">●</span>
          </div>
        </div>
        <div class="session-actions" @click.stop>
          <button class="icon-btn" title="导出" @click="emit('export', s.sessionId)">📥</button>
          <button class="icon-btn" title="删除" @click="emit('delete', s.sessionId)">🗑</button>
        </div>
      </div>
      <div v-if="sessions.length === 0" class="empty-sessions">
        暂无会话
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.new-session-btn {
  margin: 12px;
  padding: 10px;
  background: var(--accent);
  color: #000;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}
.new-session-btn:hover {
  opacity: 0.9;
}
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 4px;
}
.session-item:hover {
  background: var(--bg);
}
.session-item.active {
  background: var(--bg);
  border: 1px solid var(--accent);
}
.session-info {
  flex: 1;
  min-width: 0;
}
.session-title {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-meta {
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
.active-dot {
  color: var(--accent);
}
.session-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.session-item:hover .session-actions {
  opacity: 1;
}
.icon-btn {
  background: transparent;
  border: none;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}
.icon-btn:hover {
  background: var(--border);
}
.empty-sessions {
  text-align: center;
  color: var(--text-dim);
  font-size: 13px;
  padding: 20px;
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
