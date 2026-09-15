<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import type { GitStatus, SessionListItem } from '../types';
import { useSidebarState, GROUP_COLLAPSE_LIMIT } from '../composables/useSidebarState';
import { useFileTreeState } from '../composables/useFileTreeState';
import { tryOpenSettingsModal, useSettingsModal } from '../composables/useSettingsModal';
import { relativeTimeLabel } from '../utils/relativeTime';
import { MOD_KEY_LABEL } from '../utils/platform';
import FileTree from './FileTree.vue';
import SvgIcon from './ui/SvgIcon.vue';
import logoUrl from '../assets/logo-v2.svg';

export type ShellView = 'home' | 'chat' | 'skills' | 'settings';
export type SidebarSection = 'sessions' | 'files';

const props = withDefaults(
  defineProps<{
    view: ShellView;
    sessions: SessionListItem[];
    currentSessionId?: string | null;
    /** Workdir of the current session — the file tree roots here. */
    workDir?: string | null;
    gitStatus?: GitStatus | null;
    /** Refreshes git status when the file tree's refresh button is hit. */
    refreshGit?: () => void;
    /** Desktop rail mode: 288px full sidebar collapses to a 56px icon strip. */
    collapsed?: boolean;
    /** The mobile overlay is already a drawer; its toggle would only flip a
        desktop-only grid track, so the button is hidden there. */
    showCollapseToggle?: boolean;
  }>(),
  {
    currentSessionId: null,
    workDir: null,
    gitStatus: null,
    refreshGit: undefined,
    collapsed: false,
    showCollapseToggle: true,
  },
);

const emit = defineEmits<{
  (e: 'navigate', id: ShellView): void;
  (e: 'switch-session', id: string): void;
  (e: 'delete-session', id: string): void;
  (e: 'create-session'): void;
  (e: 'toggle-collapse'): void;
  (e: 'open-file', path: string): void;
  (e: 'rename-session', id: string, title: string): void;
  /** Export/fork moved to the chat header "more" menu — session-scoped actions belong to the conversation view. */
}>();

/* ── Search filter (⌘K focuses this box) ─────────────────────────────────── */
const searchRef = ref<HTMLInputElement | null>(null);
// Query + collapsed spaces + active section live in module-level shared state:
// WebShell mounts this component twice (desktop rail + mobile drawer) and both
// copies must show the same list.
const { query, collapsedSpaces, section, toggleSpace, toggleSpaceExpanded, isSpaceExpanded } =
  useSidebarState();

function focusSearch(): void {
  searchRef.value?.focus();
  searchRef.value?.select();
}

/* L3 settings modal: when a SettingsModal host is mounted the entry opens the
  centred modal first; without a host (older wiring / test environment) tryOpen
  returns false, so the emit navigate('settings') route keeps working as before. */
const { open: settingsModalOpen } = useSettingsModal();
function onSettingsNavClick(): void {
  if (tryOpenSettingsModal()) return;
  emit('navigate', 'settings');
}

defineExpose({ focusSearch });

const filteredSessions = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.sessions;
  return props.sessions.filter((s) => sessionTitle(s).toLowerCase().includes(q) || s.workDir.toLowerCase().includes(q));
});

/* ── Spaces: sessions grouped by workDir, collapsible ────────────────────── */
interface SpaceGroup {
  /** Stable group key — the full working directory, not the basename, so two
      different paths with the same last segment never merge. */
  key: string;
  name: string;
  items: SessionListItem[];
}

const spaces = computed<SpaceGroup[]>(() => {
  const groups = new Map<string, SpaceGroup>();
  for (const s of filteredSessions.value) {
    const dir = s.workDir || '默认空间';
    const parts = dir.split(/[\\/]/).filter(Boolean);
    const name = parts.length > 0 ? parts[parts.length - 1]! : dir;
    const g = groups.get(dir);
    if (g) g.items.push(s);
    else groups.set(dir, { key: dir, name, items: [s] });
  }
  // Current session's space first, then by recency.
  const currentDir = props.sessions.find((s) => s.sessionId === props.currentSessionId)?.workDir;
  return [...groups.values()].sort((a, b) => {
    if (a.key === currentDir) return -1;
    if (b.key === currentDir) return 1;
    return (b.items[0]?.createdAt ?? 0) - (a.items[0]?.createdAt ?? 0);
  });
});

/**
 * A group shows only its first GROUP_COLLAPSE_LIMIT rows (with long session lists
 * every screen would otherwise be the tail of one space). Search never collapses:
 * the user is after one specific row, and hiding matches reads as "no hits".
 */
function visibleItems(group: SpaceGroup): SessionListItem[] {
  if (query.value.trim() || isSpaceExpanded(group.key)) return group.items;
  return group.items.length > GROUP_COLLAPSE_LIMIT
    ? group.items.slice(0, GROUP_COLLAPSE_LIMIT)
    : group.items;
}

function hiddenCount(group: SpaceGroup): number {
  return Math.max(0, group.items.length - GROUP_COLLAPSE_LIMIT);
}

function onSessionClick(id: string): void {
  emit('switch-session', id);
}

/** The currently open session — the only row rename is offered for, matching the server-side guard. */
function isCurrent(s: SessionListItem): boolean {
  return s.sessionId === props.currentSessionId;
}

/* ── Row actions: pencil rename + delete confirm popover ──────────────────────
 * A "⋯" overflow menu buried the delete entry; always-visible semantic icons
 * replaced it, and an explicit confirmation is still wanted — so the trash can
 * opens an inline confirm popover (cancel / confirm delete) instead of a
 * second-level menu or an invisible state change. */
const confirmDeleteId = ref<string | null>(null);

function onDeleteClick(s: SessionListItem): void {
  confirmDeleteId.value = confirmDeleteId.value === s.sessionId ? null : s.sessionId;
}
function closeDeleteConfirm(): void {
  confirmDeleteId.value = null;
}
function confirmDeleteSession(id: string): void {
  closeDeleteConfirm();
  emit('delete-session', id);
}

// Any pointerdown outside closes the popover (document capture phase; the popover
// itself is exempt via stopPropagation).
function onDocPointerDown(ev: PointerEvent): void {
  if (!confirmDeleteId.value) return;
  const t = ev.target as HTMLElement | null;
  if (t && typeof t.closest === 'function' && t.closest('.session-actions')) return;
  closeDeleteConfirm();
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown));

function onOpenFile(path: string): void {
  emit('open-file', path);
}

/* ── Inline session rename (G5.2) ──────────────────────────────────────── */
/** Only one row is in edit mode at a time; a function ref collects it explicitly
    instead of the string-ref-into-array pitfall inside v-for, which used to throw
    `.focus is not a function`. */
const renameInputRef = ref<HTMLInputElement | null>(null);

function setRenameRef(el: Element | ComponentPublicInstance | null): void {
  renameInputRef.value = el as HTMLInputElement | null;
}

const renamingId = ref<string | null>(null);
const renameDraft = ref('');

function startRename(s: SessionListItem): void {
  renamingId.value = s.sessionId;
  renameDraft.value = sessionTitle(s);
  nextTick(() => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  });
}
function cancelRename(): void {
  renamingId.value = null;
  renameDraft.value = '';
}
function commitRename(id: string): void {
  const draft = renameDraft.value.trim();
  renamingId.value = null;
  renameDraft.value = '';
  if (!draft) return;
  const s = props.sessions.find((x) => x.sessionId === id);
  if (!s || draft === sessionTitle(s)) return;
  emit('rename-session', id, draft);
}

/** Relative-time wording lives in utils/relativeTime.ts (today HH:mm / yesterday / N days ago / M/D). */
function relativeTime(ts: number): string {
  return relativeTimeLabel(ts);
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

    <!-- Section switch: session list vs file tree (expanded mode only; the
         collapsed rail keeps the session dots, no tree chrome). -->
    <div v-if="!collapsed" class="section-switch" role="tablist" aria-label="侧栏分区">
      <button
        class="section-tab"
        :class="{ active: section === 'sessions' }"
        role="tab"
        :aria-selected="section === 'sessions'"
        @click="section = 'sessions'"
      >
        <SvgIcon name="message-circle" :size="13" />
        <span>会话</span>
      </button>
      <button
        class="section-tab"
        :class="{ active: section === 'files' }"
        role="tab"
        :aria-selected="section === 'files'"
        @click="section = 'files'"
      >
        <SvgIcon name="folder" :size="13" />
        <span>文件</span>
      </button>
    </div>

    <!-- Files section: the file tree replaces search + spaces. -->
    <FileTree
      v-if="!collapsed && section === 'files'"
      :work-dir="workDir"
      :git-status="gitStatus"
      :refresh-git="refreshGit"
      @open-file="onOpenFile"
    />

    <!-- Sessions section. The collapsed rail has no section switch, so it must
         always show the space dots — the `collapsed ||` guard keeps that. -->
    <template v-if="collapsed || section === 'sessions'">
      <label v-if="!collapsed" class="side-search">
        <SvgIcon name="search" :size="15" />
        <input
          ref="searchRef"
          v-model="query"
          type="text"
          :placeholder="`搜索会话… (${MOD_KEY_LABEL}K)`"
          aria-label="搜索会话"
          spellcheck="false"
        />
      </label>
      <div class="spaces">
      <div v-for="group in spaces" :key="group.key" class="space-group">
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
          <button class="space-head" :title="group.key" @click="toggleSpace(group.key)">
            <SvgIcon :name="collapsedSpaces.has(group.key) ? 'chevron-right' : 'chevron-down'" :size="14" />
            <span class="space-name">{{ group.name }}</span>
            <span class="space-count">{{ group.items.length }}</span>
          </button>
          <div v-if="!collapsedSpaces.has(group.key)" class="space-sessions">
            <div
              v-for="s in visibleItems(group)"
              :key="s.sessionId"
              class="session-item-wrap"
            >
              <button
                class="session-item"
                :class="{ active: s.sessionId === currentSessionId }"
                :title="sessionTitle(s)"
                @click="onSessionClick(s.sessionId)"
                @dblclick="startRename(s)"
              >
                <span v-if="s.active" class="session-run" aria-hidden="true" />
                <span class="session-text">
                  <span v-if="renamingId === s.sessionId" class="session-rename">
                    <input
                      :ref="setRenameRef"
                      v-model="renameDraft"
                      class="rename-input"
                      spellcheck="false"
                      :aria-label="`重命名会话 ${sessionTitle(s)}`"
                      @click.stop
                      @keydown.enter.prevent="commitRename(s.sessionId)"
                      @keydown.esc.prevent="cancelRename()"
                      @blur="commitRename(s.sessionId)"
                    />
                  </span>
                  <template v-else>
                    <span class="session-title">{{ sessionTitle(s) }}</span>
                    <span class="session-meta">
                      <span>{{ relativeTime(s.createdAt) }}</span>
                      <!-- messageCount = -1 means the server has not loaded the messages yet (an
                           archived session is inactive):
                           showing nothing beats inventing a zero. -->
                      <template v-if="s.messageCount >= 0">
                        <span class="meta-sep" aria-hidden="true">·</span>
                        <span>{{ s.messageCount }} 条</span>
                      </template>
                    </span>
                  </template>
                </span>
              </button>
              <!-- Row actions: always-visible pencil (rename) + trash can (opens the confirm popover).
                   The old "⋯" menu buried delete; semantic icons show it directly. -->
              <div class="session-actions">
                <button
                  type="button"
                  class="session-act"
                  :disabled="!isCurrent(s)"
                  :title="isCurrent(s) ? '重命名会话' : '只有当前打开的会话能重命名'"
                  :aria-label="`重命名会话：${sessionTitle(s)}`"
                  @click.stop="startRename(s)"
                >
                  <SvgIcon name="edit" :size="14" />
                </button>
                <button
                  type="button"
                  class="session-act session-act--danger"
                  :title="`删除会话：${sessionTitle(s)}`"
                  :aria-label="`删除会话：${sessionTitle(s)}`"
                  @click.stop="onDeleteClick(s)"
                >
                  <SvgIcon name="trash" :size="14" />
                </button>
                <div
                  v-if="confirmDeleteId === s.sessionId"
                  class="delete-confirm"
                  role="alertdialog"
                  :aria-label="`确认删除：${sessionTitle(s)}`"
                >
                  <div class="delete-confirm-text">删除「{{ sessionTitle(s) }}」？不可恢复。</div>
                  <div class="delete-confirm-actions">
                    <button type="button" class="dc-btn" @click.stop="closeDeleteConfirm">取消</button>
                    <button
                      type="button"
                      class="dc-btn dc-btn--danger"
                      @click.stop="confirmDeleteSession(s.sessionId)"
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <button
              v-if="!query && hiddenCount(group) > 0"
              class="space-more"
              type="button"
              :title="isSpaceExpanded(group.key) ? '收起，只留最近几条' : `展开这个空间的其余会话`"
              @click="toggleSpaceExpanded(group.key)"
            >
              <SvgIcon name="chevron-down" :size="12" :class="{ 'is-up': isSpaceExpanded(group.key) }" />
              <span>{{
                isSpaceExpanded(group.key)
                  ? '收起'
                  : `显示更多 ${hiddenCount(group)} 条`
              }}</span>
            </button>
          </div>
        </template>
      </div>
      <p v-if="!collapsed && spaces.length === 0" class="spaces-empty">
        {{ query ? '没有匹配的会话' : '还没有会话，点击上方「新建对话」开始' }}
      </p>
    </div>
    </template>

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
        :class="{ active: view === 'settings' || settingsModalOpen }"
        :title="collapsed ? '设置' : undefined"
        @click="onSettingsNavClick"
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

/* ── Collapsed rail (56px): icons only, tooltips carry the meaning ───────── */
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
  .session-act { transition: none; }
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
/* 40px = 56px rail minus the 2×8px rail padding: the widest thing the rail
   can hold without clipping. */
.is-collapsed .brand-logo {
  height: auto;
  width: 40px;
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

/* ── Section switch (sessions | files) ──────────────────────────────────── */
.section-switch {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  flex-shrink: 0;
}
.section-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  flex: 1;
  min-height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.section-tab:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.section-tab.active {
  background: var(--color-selected);
  color: var(--color-text);
  font-weight: 600;
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
  gap: 2px;
}
.space-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
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
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: var(--color-selected);
  color: var(--color-text-faint);
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.space-sessions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: var(--space-3);
}
.session-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: 52px;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
}
.session-item:hover {
  background: var(--color-hover);
}
.session-item.active {
  background: var(--color-selected);
}
/* Active marker: a 2px brand-colour bar inset from the row's left edge —
   quieter than bolding the title and monochrome-safe in both themes. */
.session-item.active::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
/* Running indicator: the session's agent is mid-turn. */
.session-run {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
  flex-shrink: 0;
}
@media (prefers-reduced-motion: reduce) {
  .session-run { animation: none; }
}
.session-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.session-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  font-weight: 500;
  line-height: 1.35;
}
.session-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1.2;
  letter-spacing: 0.03em;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.meta-sep {
  opacity: 0.6;
}
/* Row action group: always-visible pencil (rename) + trash can (confirm popover).
   Semantic icons replaced the "⋯" menu that buried the delete entry.
   It owns a fixed grid column (no longer absolutely positioned over the title);
   position:relative anchors the confirm popover and z-index keeps it above the
   rows below. */
.session-actions {
  position: relative;
  display: flex;
  gap: 2px;
  padding-right: var(--space-2);
  z-index: 2;
}
.session-act {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0.75;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.session-act:hover:not(:disabled) {
  opacity: 1;
  color: var(--color-text);
  background: var(--color-hover);
}
.session-act:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
/* Delete confirm popover: cancel / confirm delete shown directly, no implicit state. */
.delete-confirm {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  width: 208px;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--color-surface-raised);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-elevation-prominent);
  z-index: var(--z-popover, 60);
}
.delete-confirm-text {
  font-size: var(--font-size-sm);
  color: var(--color-text);
}
.delete-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.dc-btn {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.dc-btn:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.dc-btn--danger {
  color: #fff;
  background: var(--color-danger);
  border-color: var(--color-danger);
}
.dc-btn--danger:hover {
  color: #fff;
  filter: brightness(1.08);
}

/* Inline rename input (G5.2) */
/* Row container: shrinkable title track (minmax(0,1fr)) + fixed column for the
   action group. That group used to be absolutely positioned over the title, which
   both covered it and pushed the row past the rail. With this two-column grid the
   title ellipsizes on its own and the actions keep their own slot — any title
   length stays overlap- and overflow-free. */
.session-item-wrap {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-width: 0;
}
.session-rename {
  display: block;
  width: 100%;
}
.rename-input {
  width: 100%;
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-size: var(--font-size-xs);
  font-family: inherit;
  outline: none;
  box-shadow: var(--glow-focus);
}
.session-act--danger:hover:not(:disabled) {
  color: var(--color-danger);
}

/* Collapse button: only appears for groups over 5 rows, styled as a subdued line of helper text. */
.space-more {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 26px;
  margin-top: 2px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-faint);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.space-more:hover {
  color: var(--color-text-muted);
  background: var(--color-hover);
}
/* Expanded state rotates the arrow 180°: cheaper than shipping an up icon, and the swap stays instant. */
.space-more .is-up {
  transform: rotate(180deg);
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
