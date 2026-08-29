<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionListItem } from '../types';
import SvgIcon from './ui/SvgIcon.vue';
import logoUrl from '../assets/logo-v2.svg';

export type ShellView = 'home' | 'chat' | 'skills' | 'settings';

const props = withDefaults(
  defineProps<{
    view: ShellView;
    sessions: SessionListItem[];
    currentSessionId?: string | null;
    /** Desktop rail mode: 288px full sidebar collapses to a 64px icon strip. */
    collapsed?: boolean;
    /** The mobile overlay is already a drawer; its toggle would only flip a
        desktop-only grid track, so the button is hidden there. */
    showCollapseToggle?: boolean;
  }>(),
  { currentSessionId: null, collapsed: false, showCollapseToggle: true },
);

const emit = defineEmits<{
  (e: 'navigate', id: ShellView): void;
  (e: 'switch-session', id: string): void;
  (e: 'delete-session', id: string): void;
  (e: 'create-session'): void;
  (e: 'toggle-collapse'): void;
}>();

/* ── Search filter (⌘K focuses this box) ─────────────────────────────────── */
const searchRef = ref<HTMLInputElement | null>(null);
const query = ref('');

function focusSearch(): void {
  searchRef.value?.focus();
  searchRef.value?.select();
}

defineExpose({ focusSearch });

const filteredSessions = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.sessions;
  return props.sessions.filter((s) => sessionTitle(s).toLowerCase().includes(q) || s.workDir.toLowerCase().includes(q));
});

/* ── Spaces: sessions grouped by workDir, collapsible ────────────────────── */
interface SpaceGroup {
  name: string;
  workDir: string;
  items: SessionListItem[];
}

const spaces = computed<SpaceGroup[]>(() => {
  const groups = new Map<string, SpaceGroup>();
  for (const s of filteredSessions.value) {
    const dir = s.workDir || '默认空间';
    const parts = dir.split(/[\\/]/).filter(Boolean);
    const name = parts.length > 0 ? parts[parts.length - 1]! : dir;
    const g = groups.get(name);
    if (g) g.items.push(s);
    else groups.set(name, { name, workDir: dir, items: [s] });
  }
  // Current session's space first, then by recency.
  const currentDir = props.sessions.find((s) => s.sessionId === props.currentSessionId)?.workDir;
  return [...groups.values()].sort((a, b) => {
    if (a.workDir === currentDir) return -1;
    if (b.workDir === currentDir) return 1;
    return (b.items[0]?.createdAt ?? 0) - (a.items[0]?.createdAt ?? 0);
  });
});

/** Collapsed space names (all expanded by default). */
const collapsedSpaces = ref<Set<string>>(new Set());

function toggleSpace(name: string): void {
  const next = new Set(collapsedSpaces.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  collapsedSpaces.value = next;
}

function onSessionClick(id: string): void {
  emit('switch-session', id);
}

function confirmDelete(id: string, title: string): void {
  if (window.confirm(`删除会话「${title}」？此操作不可恢复。`)) {
    emit('delete-session', id);
  }
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function sessionTitle(s: SessionListItem): string {
  const t = (s.title || '').trim();
  if (t && t !== '新会话' && t !== 'New Session') return t;
  return '未命名会话';
}
</script>

<template>
  <aside :class="['sidebar', { 'is-collapsed': collapsed }]">
    <div class="sidebar-head">
      <button class="sidebar-brand" title="回到新对话" @click="emit('navigate', 'home')">
        <img class="brand-logo" :src="logoUrl" alt="scream" />
      </button>
      <button
        v-if="showCollapseToggle"
        class="collapse-btn"
        :class="{ rotated: collapsed }"
        :title="collapsed ? '展开侧栏' : '折叠侧栏'"
        :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'"
        :aria-expanded="!collapsed"
        @click="emit('toggle-collapse')"
      >
        <SvgIcon name="panel-left" :size="15" />
      </button>
    </div>

    <button class="new-chat-btn" :title="collapsed ? '新建对话' : undefined" @click="emit('create-session')">
      <SvgIcon name="plus" :size="16" />
      <span v-if="!collapsed">新建对话</span>
    </button>

    <label v-if="!collapsed" class="side-search">
      <SvgIcon name="search" :size="15" />
      <input
        ref="searchRef"
        v-model="query"
        type="text"
        placeholder="搜索会话… (⌘K)"
        aria-label="搜索会话"
        spellcheck="false"
      />
    </label>

    <div class="spaces">
      <div v-for="group in spaces" :key="group.name" class="space-group">
        <!-- Rail mode: one letter per space; clicking expands the rail and the
             sessions under that space appear again. -->
        <button
          v-if="collapsed"
          class="space-dot"
          :class="{ active: group.items.some((s) => s.sessionId === currentSessionId) }"
          :title="group.name"
          @click="emit('toggle-collapse')"
        >
          {{ group.name.slice(0, 1).toUpperCase() }}
        </button>
        <template v-else>
          <button class="space-head" :title="group.workDir" @click="toggleSpace(group.name)">
            <SvgIcon :name="collapsedSpaces.has(group.name) ? 'chevron-right' : 'chevron-down'" :size="14" />
            <span class="space-name">{{ group.name }}</span>
            <span class="space-count">{{ group.items.length }}</span>
          </button>
          <div v-if="!collapsedSpaces.has(group.name)" class="space-sessions">
            <button
              v-for="s in group.items"
              :key="s.sessionId"
              class="session-item"
              :class="{ active: s.sessionId === currentSessionId }"
              :title="sessionTitle(s)"
              @click="onSessionClick(s.sessionId)"
            >
              <span class="session-title">{{ sessionTitle(s) }}</span>
              <span class="session-meta">{{ relativeTime(s.createdAt) }}</span>
              <span
                class="session-delete"
                role="button"
                tabindex="0"
                :title="`删除会话 ${sessionTitle(s)}`"
                aria-label="删除会话"
                @click.stop="confirmDelete(s.sessionId, sessionTitle(s))"
                @keydown.enter.stop.prevent="confirmDelete(s.sessionId, sessionTitle(s))"
              >
                <SvgIcon name="trash" :size="14" />
              </span>
            </button>
          </div>
        </template>
      </div>
      <p v-if="!collapsed && spaces.length === 0" class="spaces-empty">
        {{ query ? '没有匹配的会话' : '还没有会话，点击上方「新建对话」开始' }}
      </p>
    </div>

    <nav class="sidebar-foot" aria-label="功能区">
      <button
        class="foot-item"
        :class="{ active: view === 'skills' }"
        :title="collapsed ? '技能中心' : undefined"
        @click="emit('navigate', 'skills')"
      >
        <SvgIcon name="sparkles" :size="17" />
        <span v-if="!collapsed">技能中心</span>
      </button>
      <button
        class="foot-item"
        :class="{ active: view === 'settings' }"
        :title="collapsed ? '设置' : undefined"
        @click="emit('navigate', 'settings')"
      >
        <SvgIcon name="settings" :size="17" />
        <span v-if="!collapsed">设置</span>
      </button>
      <div class="sidebar-identity">
        <span class="identity-dot" aria-hidden="true" />
        <span v-if="!collapsed" class="identity-text">scream web</span>
      </div>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: var(--sidebar-width);
  height: 100%;
  padding: var(--space-4) var(--space-3) var(--space-3);
  background: var(--color-surface-sunken);
  border-right: 1px solid var(--color-line);
  overflow: hidden;
  transition: width var(--dur-slower) var(--ease-out);
}

/* ── Collapsed rail (64px): icons only, tooltips carry the meaning ───────── */
.sidebar.is-collapsed {
  width: var(--sidebar-width-collapsed);
  gap: var(--space-2);
  padding: var(--space-3) var(--space-2);
  align-items: center;
}
.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  width: 100%;
}
.sidebar-head .sidebar-brand { flex: 1; min-width: 0; }
.collapse-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.collapse-btn:hover { color: var(--color-accent); background: var(--color-hover); }
.collapse-btn.rotated { transform: rotate(180deg); }
/* Rail mode: the wordmark IS the brand, so it stays — stacked above the
   collapse button instead of replacing it. */
.is-collapsed .sidebar-head {
  flex-direction: column;
  justify-content: flex-start;
  gap: var(--space-1);
}
.is-collapsed .sidebar-brand { padding: 0; justify-content: center; width: 100%; }
.is-collapsed .new-chat-btn {
  width: 40px;
  padding: 0;
  border-radius: var(--radius-md);
}
.is-collapsed .spaces { align-items: center; }
.space-dot {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
  font-weight: 700;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.space-dot:hover { border-color: var(--color-line-strong); color: var(--color-text); }
.space-dot.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
}
.is-collapsed .sidebar-foot { align-items: center; }
.is-collapsed .foot-item { width: 36px; justify-content: center; padding: 0; }
.is-collapsed .sidebar-identity { justify-content: center; }
@media (prefers-reduced-motion: reduce) {
  .sidebar { transition: none; }
  .collapse-btn { transition: none; }
}

/* ── Brand (click = new chat home) ───────────────────────────────────────── */
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: background var(--dur-fast) var(--ease-out);
}
.sidebar-brand:hover {
  background: var(--color-hover);
}
/* Wordmark asset (1920×428, pure black fills). It carries its own lettering, so
   the old mark + text pair is gone. The artwork is single-colour, so the dark
   theme inverts it instead of shipping a second file. */
.brand-logo {
  display: block;
  height: 22px;
  width: auto;
  flex: 0 0 auto;
}
:root[data-theme='dark'] .brand-logo {
  filter: invert(1) grayscale(1);
}
.is-collapsed .brand-logo {
  height: auto;
  width: 42px;
}

/* ── New chat primary button ─────────────────────────────────────────────── */
.new-chat-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: var(--font-size-base);
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-xs);
  transition:
    filter var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.new-chat-btn:hover {
  filter: brightness(1.12);
}
.new-chat-btn:active {
  transform: translateY(1px);
}

/* ── Search ──────────────────────────────────────────────────────────────── */
.side-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-faint);
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.side-search:focus-within {
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}
.side-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  outline: none;
}
.side-search input::placeholder {
  color: var(--color-text-faint);
}

/* ── Spaces (collapsible groups owning their sessions) ───────────────────── */
.spaces {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-right: 2px;
}
.space-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.space-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.space-head:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.space-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.space-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-faint);
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-selected);
}
.space-sessions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: var(--space-3);
}
.session-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.session-item:hover {
  background: var(--color-hover);
}
.session-item.active {
  background: var(--color-selected);
}
.session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
}
.session-meta {
  font-size: 11px;
  color: var(--color-text-faint);
  flex-shrink: 0;
}
.session-delete {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: none;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  color: var(--color-text-muted);
  cursor: pointer;
}
.session-item:hover .session-delete,
.session-delete:focus-visible {
  display: grid;
}
.session-delete:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.spaces-empty {
  padding: var(--space-3) var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-faint);
  line-height: 1.5;
}

/* ── Footer nav ──────────────────────────────────────────────────────────── */
.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid var(--color-line);
  padding-top: var(--space-2);
}
.foot-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 38px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.foot-item:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.foot-item.active {
  background: var(--color-selected);
  color: var(--color-text);
  font-weight: 600;
}
.sidebar-identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
.identity-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-success);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
}
.identity-text {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

@media (max-width: 640px) {
  .sidebar {
    display: none;
  }
  .new-chat-btn {
    min-height: 44px;
  }
  .space-head {
    min-height: 40px;
  }
}
</style>
