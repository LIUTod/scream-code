<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ChatMessage } from '../types';
import MessageItem from './MessageItem.vue';
import EmptyState from './EmptyState.vue';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[];
    busy?: boolean;
    workDir?: string | null;
    /** Current session id - used to persist/restore the scroll position. */
    sessionId?: string;
    /** Current model label shown in the empty-state status bar. */
    model?: string | null;
    /** Context usage (0..1 or 0..100) shown in the empty-state status bar. */
    contextUsage?: number | null;
    /** Connection state shown in the empty-state status bar. */
    connected?: boolean;
    /** Older history exists beyond the loaded window (pagination sentinel). */
    olderAvailable?: boolean;
    /** True while the parent is fetching an older page. */
    olderLoading?: boolean;
  }>(),
  { busy: false, workDir: null, sessionId: '', model: null, contextUsage: null, connected: false, olderAvailable: false, olderLoading: false },
);

const emit = defineEmits<{
  (e: 'edit', content: string): void;
  (e: 'pick', text: string): void;
  (e: 'retry-connection'): void;
  (e: 'retry-message'): void;
  (e: 'load-older'): void;
  (e: 'fork'): void;
}>();

const listRef = ref<HTMLElement | null>(null);

const latestUserId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i]!.role === 'user') return props.messages[i]!.id;
  }
  return null;
});

const lastMessageId = computed(() => props.messages.at(-1)?.id ?? null);
const lastAssistantId = computed(() => [...props.messages].reverse().find((m) => m.role === 'assistant')?.id ?? null);

/**
 * Timestamp grouping: inside a run of consecutive assistant
 * messages only the LAST one shows its timestamp; a gap > 5 minutes forces it
 * back on. User/system messages always show theirs (they break the run).
 */
function showTimestampFor(index: number): boolean {
  const m = props.messages[index];
  if (!m) return false;
  if (m.role !== 'assistant') return true;
  const next = props.messages[index + 1];
  if (!next || next.role !== 'assistant') return true;
  if (m.ts !== undefined && next.ts !== undefined && next.ts - m.ts > 5 * 60 * 1000) return true;
  return false;
}

/** Streaming content length - drives scroll pinning during deltas. */
const streamLength = computed(() => {
  const last = props.messages.at(-1);
  if (!last) return 0;
  let len = last.content.length;
  for (const t of last.tools) len += t.output?.length ?? 0;
  return len;
});

/** Tracks whether we should force-scroll during the current assistant turn. */
let forceScroll = false;

/** Whether the user has scrolled away from the bottom. */
const showScrollButton = ref(false);

function isNearBottom(): boolean {
  const el = listRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToBottom(behavior: ScrollBehavior): void {
  // Wait for the DOM update, then scroll. rAF is more reliable than
  // nextTick for read-after-write scroll offsets.
  requestAnimationFrame(() => {
    const el = listRef.value;
    if (!el) return;
    const finalBehavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : behavior;
    el.scrollTo({ top: el.scrollHeight, behavior: finalBehavior });
  });
}

let saveScrollRaf: number | null = null;

/** Persist the current scroll offset (rAF-coalesced) for session switches/refresh. */
function saveScrollPosition(): void {
  const el = listRef.value;
  const sid = props.sessionId;
  if (!el || !sid) return;
  if (saveScrollRaf !== null) return;
  saveScrollRaf = requestAnimationFrame(() => {
    saveScrollRaf = null;
    try {
      localStorage.setItem(`scream-scroll:${sid}`, String(el!.scrollTop));
    } catch {
      // Best-effort.
    }
  });
}

function restoreScrollPosition(): void {
  const el = listRef.value;
  const sid = props.sessionId;
  if (!el || !sid) return;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(`scream-scroll:${sid}`);
  } catch {
    // Best-effort.
  }
  if (saved) el.scrollTop = Number(saved);
}

/** Keep the viewport anchored when an older page is prepended above. */
let prependAnchorHeight = 0;
watch(
  () => props.olderLoading,
  (loading) => {
    const el = listRef.value;
    if (!el) return;
    if (loading) {
      prependAnchorHeight = el.scrollHeight;
    } else if (prependAnchorHeight > 0) {
      const delta = el.scrollHeight - prependAnchorHeight;
      if (delta > 0) {
        el.scrollTop = el.scrollTop + delta;
      }
      prependAnchorHeight = 0;
    }
  },
);

function onScroll(): void {
  const el = listRef.value;
  if (!el) return;
  const awayFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  showScrollButton.value = awayFromBottom;
  // User scrolled up during a pinned turn -> release the pin so streaming
  // deltas stop dragging them back down.
  if (awayFromBottom && forceScroll) {
    forceScroll = false;
  }
  if (!props.busy) {
    saveScrollPosition();
  }
}

let restoredForSession = '';

watch(
  () => props.sessionId,
  () => {
    // Session switched: clear the restore marker so the first content load
    // restores the saved position instead of force-scrolling to bottom.
    restoredForSession = '';
  },
);

watch(
  () => [props.messages.length, streamLength.value],
  ([len], [oldLen]) => {
    // New message added -> always scroll to bottom and pin subsequent deltas.
    if (len !== oldLen) {
      // First load for this session: restore the saved scroll position.
      if (len > 0 && restoredForSession !== props.sessionId) {
        restoredForSession = props.sessionId;
        requestAnimationFrame(() => requestAnimationFrame(restoreScrollPosition));
        return;
      }
      forceScroll = true;
      showScrollButton.value = false;
      scrollToBottom('smooth');
      return;
    }
    // Streaming delta -> follow if near bottom or if we pinned this turn.
    if (!forceScroll && !isNearBottom()) return;
    scrollToBottom('auto');
  },
);

// Reset force-scroll when the turn ends (busy goes false).
watch(
  () => props.busy,
  (busy) => { if (!busy) forceScroll = false; },
);

function handleScrollButtonClick(): void {
  forceScroll = true;
  showScrollButton.value = false;
  scrollToBottom('smooth');
}

/** Skeleton placeholder while waiting for the assistant's first delta. */
const showSkeleton = computed(() => {
  if (!props.busy || props.messages.length === 0) return false;
  return props.messages.at(-1)!.role === 'user';
});

onMounted(() => {
  listRef.value?.addEventListener('scroll', onScroll, { passive: true });
  // Refresh recovery: restore the saved scroll position once rendered.
  requestAnimationFrame(() => requestAnimationFrame(restoreScrollPosition));
});

onUnmounted(() => {
  listRef.value?.removeEventListener('scroll', onScroll);
  if (saveScrollRaf !== null) {
    cancelAnimationFrame(saveScrollRaf);
    saveScrollRaf = null;
  }
});
</script>

<template>
  <div class="message-list-wrapper">
    <div v-if="!connected && messages.length > 0" class="conn-banner" role="status">
      <span class="conn-dot" aria-hidden="true" />
      <span>连接中断，自动恢复中…</span>
      <button class="conn-retry" @click="emit('retry-connection')">立即重试</button>
    </div>
    <div ref="listRef" class="message-list">
      <div v-if="olderAvailable" class="load-older-row">
        <button class="load-older-btn" :disabled="olderLoading" @click="emit('load-older')">
          {{ olderLoading ? '加载中…' : '加载更早消息' }}
        </button>
      </div>
      <EmptyState
        v-if="messages.length === 0"
        :work-dir="workDir"
        :model="model"
        :context-usage="contextUsage"
        :connected="connected"
        @pick="(t) => emit('pick', t)"
      />
      <MessageItem
        v-for="(message, index) in messages"
        :key="message.id"
        :message="message"
        :is-latest-user="message.id === latestUserId"
        :idle="!busy"
        :streaming="busy && message.id === lastMessageId && message.role === 'assistant'"
        :session-id="sessionId"
        :can-fork="!busy && message.id === lastAssistantId"
        :show-timestamp="showTimestampFor(index)"
        @edit="(content) => emit('edit', content)"
        @retry="emit('retry-message')"
        @fork="emit('fork')"
      />
      <div v-if="showSkeleton" class="message-skeleton" aria-hidden="true">
        <div class="sk-body">
          <div class="sk-line sk-w-60" />
          <div class="sk-line sk-w-90" />
          <div class="sk-line sk-w-40" />
        </div>
      </div>
    </div>
    <Transition name="scroll-btn">
      <button
        v-if="showScrollButton"
        class="scroll-to-bottom"
        title="滚动到最新消息"
        @click="handleScrollButtonClick"
      >
        <SvgIcon name="chevron-down" :size="18" />
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.message-list-wrapper {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.load-older-row {
  display: flex;
  justify-content: center;
  padding: var(--space-2);
}
.load-older-btn {
  min-height: 30px;
  padding: 0 var(--space-4);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.load-older-btn:hover:not(:disabled) {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
}

.conn-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--color-warning-soft);
  border-bottom: 1px solid var(--color-line);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}
.conn-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-warning);
  animation: breathe var(--dur-breathe) ease-in-out infinite;
  flex-shrink: 0;
}
.conn-retry {
  margin-left: auto;
  padding: 3px var(--space-3);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.conn-retry:hover {
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
}

.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: var(--space-3) 0 var(--space-2);
  overscroll-behavior: contain;
  background: var(--color-surface);
}

.scroll-to-bottom {
  position: absolute;
  bottom: var(--space-2);
  left: 50%;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-line);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: var(--shadow-md);
  z-index: 10;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.scroll-to-bottom:hover {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: var(--color-accent-bd);
  transform: translateX(-50%) translateY(-1px);
}
.scroll-to-bottom:active {
  transform: translateX(-50%) translateY(1px);
}

.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(var(--space-2));
}

/* Skeleton placeholder while waiting for the assistant's first delta. */
.message-skeleton {
  display: flex;
  padding: 14px var(--space-5);
  animation: rise-in var(--dur-base) var(--ease-out) both;
}
.sk-body {
  flex: 1;
  min-width: 0;
  padding-top: var(--space-1);
}
.sk-line {
  height: 12px;
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-2);
}
.sk-w-60 { width: 60%; }
.sk-w-90 { width: 90%; }
.sk-w-40 { width: 40%; }
.sk-line {
  background: var(--shimmer-line);
  background-size: var(--shimmer-width) 100%;
  animation: shimmer-slide 1.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .sk-line,
  .message-skeleton {
    animation: none;
  }
}
</style>
