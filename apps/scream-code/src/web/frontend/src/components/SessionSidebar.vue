<script setup lang="ts">
import type { SessionListItem } from '../types';

defineProps<{
  sessions: SessionListItem[];
  currentSessionId: string | null;
  /** Desktop: icon-only narrow sidebar. */
  collapsed?: boolean;
  /** Mobile: sidebar rendered as a slide-in overlay. */
  mobileOpen?: boolean;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'switch', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'export', id: string): void;
  (e: 'toggle'): void;
}>();

function confirmDelete(id: string) {
  if (window.confirm('确定要删除这个会话吗？此操作不可恢复。')) {
    emit('delete', id);
  }
}

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
  <aside :class="['sidebar', { collapsed, 'mobile-open': mobileOpen }]">
    <div class="sidebar-header">
      <div class="sidebar-toprow">
        <span class="sidebar-brand">Scream</span>
        <button
          class="collapse-btn"
          :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-expanded="!collapsed"
          @click="emit('toggle')"
        >
          <span :class="['collapse-icon', { flipped: collapsed }]">«</span>
        </button>
      </div>
      <button class="new-session-btn" :title="collapsed ? '新建会话' : undefined" @click="emit('create')">
        <span class="plus">+</span> <span class="new-label">新建会话</span>
      </button>
    </div>
    <div class="session-list">
      <TransitionGroup name="session">
        <div
          v-for="s in sessions"
          :key="s.sessionId"
          :class="['session-item', { active: s.sessionId === currentSessionId }]"
          :title="collapsed ? (s.title || 'New Session') : undefined"
          @click="emit('switch', s.sessionId)"
        >
          <div class="session-avatar">{{ (s.title || 'N').charAt(0).toUpperCase() }}</div>
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
            <button class="icon-btn danger" title="删除" @click="confirmDelete(s.sessionId)">🗑</button>
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
  width: var(--sidebar-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface-sunken);
  border-right: 1px solid var(--color-line);
  transition: width var(--dur-slow) var(--ease-out);
}
.sidebar-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.sidebar-toprow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 24px;
}
.collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-faint);
  cursor: pointer;
  font-size: var(--font-size-sm);
  line-height: 1;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.collapse-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.collapse-btn:active {
  transform: scale(0.9);
}
.collapse-icon {
  display: inline-block;
  transition: transform var(--dur-slow) var(--ease-out);
}
.collapse-icon.flipped {
  transform: rotate(180deg);
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
  background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%);
  color: var(--color-on-accent);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-xs);
  transition:
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out),
    filter var(--dur-base) var(--ease-out);
}
.new-session-btn:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm), 0 0 12px var(--color-accent-glow);
}
.new-session-btn:active {
  transform: scale(0.98);
  box-shadow: var(--shadow-xs);
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
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-line);
  background: var(--color-surface);
  cursor: pointer;
  margin-bottom: var(--space-2);
  transition:
    background var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.session-item:hover {
  background: var(--color-surface-raised);
  border-color: var(--color-line-strong);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}
.session-item.active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent-bd);
  box-shadow: 0 0 0 1px var(--color-accent-bd), 0 2px 10px var(--color-accent-glow);
}
.session-item.active:hover {
  background: var(--color-accent-soft);
  transform: none;
}
.session-info {
  flex: 1;
  min-width: 0;
}
.session-avatar {
  display: none;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  font-weight: 700;
  color: var(--color-accent);
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-bd);
}
.session-item.active .session-avatar {
  box-shadow: 0 0 8px var(--color-accent-glow);
}
.session-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.3;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-item.active .session-title {
  color: var(--color-accent);
}
.session-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 3px;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.active-dot {
  color: var(--color-accent);
  margin-left: auto;
  text-shadow: 0 0 6px var(--color-accent-glow);
}
.session-actions {
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  transform: translateX(4px);
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.session-item:hover .session-actions,
.session-item.active .session-actions {
  opacity: 1;
  transform: translateX(0);
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
  padding: var(--space-8) var(--space-3);
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

/* Collapsed (desktop only) */
@media (min-width: 641px) {
  .sidebar.collapsed {
    width: var(--sidebar-width-collapsed);
  }
  .sidebar.collapsed .sidebar-header {
    padding: var(--space-2);
    align-items: center;
  }
  .sidebar.collapsed .sidebar-brand {
    display: none;
  }
  .sidebar.collapsed .sidebar-toprow {
    justify-content: center;
  }
  .sidebar.collapsed .new-session-btn {
    width: 32px;
    height: 32px;
    padding: 0;
  }
  .sidebar.collapsed .new-label {
    display: none;
  }
  .sidebar.collapsed .session-list {
    padding: var(--space-2) var(--space-1);
  }
  .sidebar.collapsed .session-item {
    justify-content: center;
    padding: var(--space-1);
    border-color: transparent;
    background: transparent;
    box-shadow: none;
  }
  .sidebar.collapsed .session-item:hover {
    transform: none;
    box-shadow: none;
  }
  .sidebar.collapsed .session-item.active {
    background: var(--color-accent-soft);
    border-color: var(--color-accent-bd);
  }
  .sidebar.collapsed .session-avatar {
    display: inline-flex;
  }
  .sidebar.collapsed .empty-sessions {
    padding: var(--space-2) 0;
  }
  .sidebar.collapsed .empty-sessions div:not(.empty-icon) {
    display: none;
  }
  .sidebar.collapsed .session-info,
  .sidebar.collapsed .session-actions {
    display: none;
  }
}

@media (max-width: 768px) {
  .sidebar {
    width: 200px;
  }
}
@media (max-width: 640px) {
  /* Mobile: slide-in overlay instead of hidden sidebar */
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(260px, 80vw);
    z-index: var(--z-overlay);
    transform: translateX(-100%);
    transition: transform var(--dur-slow) var(--ease-out);
    box-shadow: none;
  }
  .sidebar.mobile-open {
    transform: translateX(0);
    box-shadow: var(--shadow-xl);
  }
  .sidebar .collapse-btn {
    display: none;
  }
}
</style>
