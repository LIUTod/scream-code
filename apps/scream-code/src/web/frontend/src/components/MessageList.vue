<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ChatMessage } from '../types';
import MessageItem from './MessageItem.vue';
import EmptyState from './EmptyState.vue';
import ChatMinimap from './ChatMinimap.vue';
import { formatDayDivider, isSameLocalDay } from '../utils/timeFormat';
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
/** Sentinel at the top of the list; entering the viewport auto-fetches the older page. */
const topSentinelRef = ref<HTMLElement | null>(null);
let olderObserver: IntersectionObserver | null = null;

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

/**
 * Stream dividers (render-only; scroll/unread/anchor behavior is untouched):
 * - a hairline before every user message except the first rendered row, so
 *   one question + one answer reads as one block;
 * - a centered date pill when adjacent messages cross a local midnight.
 * A day crossing suppresses the hairline at the same slot — the pill is the
 * stronger separator.
 */
function turnDividerBefore(index: number): boolean {
  const m = props.messages[index];
  return Boolean(m) && index > 0 && m.role === 'user';
}

function dayDividerBefore(index: number): string | null {
  const cur = props.messages[index];
  const prev = index > 0 ? props.messages[index - 1] : undefined;
  if (!cur || !prev || cur.ts === undefined || prev.ts === undefined) return null;
  return isSameLocalDay(prev.ts, cur.ts) ? null : formatDayDivider(cur.ts);
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
/** Messages that arrived while the user was scrolled up (FAB badge). */
const unreadCount = ref(0);

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

/**
 * Keep the viewport anchored when an older page is prepended above.
 * The watch source reads element-level state (first id + length), so an
 * in-place unshift() on the same array reference is detected too.
 */
/**
 * Set by the prepend watcher (registered first, so it runs before the length
 * watcher on the same flush). Older-page loads must not count as unread or
 * trigger a scroll-to-bottom.
 */
let justPrepended = false;

watch(
  () => [props.messages[0]?.id ?? null, props.messages.length] as const,
  ([firstId, len], [prevFirstId, prevLen]) => {
    const prepended =
      len > 0 &&
      firstId !== null &&
      prevFirstId !== null &&
      firstId !== prevFirstId &&
      len > (prevLen ?? 0);
    justPrepended = prepended;
    if (!prepended) return;
    // Capture the pre-patch scrollHeight now (pre-order watcher, Vue has not
    // patched the DOM yet) and shift by the inserted height after the patch.
    const el = listRef.value;
    if (!el) return;
    const before = el.scrollHeight;
    nextTick(() => {
      const delta = el.scrollHeight - before;
      if (delta > 0) el.scrollTop += delta;
    });
  },
);

function onScroll(): void {
  const el = listRef.value;
  if (!el) return;
  const awayFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  showScrollButton.value = awayFromBottom;
  // Back at the bottom (however the user got there): the unread badge is done.
  if (!awayFromBottom) unreadCount.value = 0;
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
    unreadCount.value = 0;
    justPrepended = false;
  },
);

watch(
  () => [props.messages.length, streamLength.value],
  ([len], [oldLen]) => {
    // New message added -> scroll to bottom and pin subsequent deltas, UNLESS
    // the user deliberately scrolled up: then count it as unread instead of
    // yanking them back down.
    if (len !== oldLen) {
      const prepended = justPrepended;
      justPrepended = false;
      // First load for this session: restore the saved scroll position.
      if (len > 0 && restoredForSession !== props.sessionId) {
        restoredForSession = props.sessionId;
        requestAnimationFrame(() => requestAnimationFrame(restoreScrollPosition));
        return;
      }
      // Older-page history load: neither unread nor follow-bottom.
      if (prepended) return;
      if (!isNearBottom()) {
        // Guard against net-negative deltas from message snapshots.
        unreadCount.value = Math.max(0, unreadCount.value + Math.max(0, len - (oldLen ?? 0)));
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
  unreadCount.value = 0;
  scrollToBottom('smooth');
}

/** Skeleton placeholder while waiting for the assistant's first delta. */
const showSkeleton = computed(() => {
  if (!props.busy || props.messages.length === 0) return false;
  return props.messages.at(-1)!.role === 'user';
});

onMounted(() => {
  listRef.value?.addEventListener('scroll', onScroll, { passive: true });
  // Auto-load older history: the sentinel sits above the first message, so it
  // is only visible when the user has scrolled to the top of the window.
  if (typeof IntersectionObserver !== 'undefined') {
    olderObserver = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (props.olderAvailable && !props.olderLoading && props.messages.length > 0) {
          emit('load-older');
        }
      },
      { root: listRef.value, rootMargin: '120px 0px 0px 0px' },
    );
    if (topSentinelRef.value) olderObserver.observe(topSentinelRef.value);
  }
  // Refresh recovery: restore the saved scroll position once rendered.
  requestAnimationFrame(() => requestAnimationFrame(restoreScrollPosition));
});

onUnmounted(() => {
  listRef.value?.removeEventListener('scroll', onScroll);
  olderObserver?.disconnect();
  olderObserver = null;
  if (saveScrollRaf !== null) {
    cancelAnimationFrame(saveScrollRaf);
    saveScrollRaf = null;
  }
});

// Re-point the observer at the sentinel whenever it (re)mounts with the
// older-page row, and stop auto-fetching once no older page exists.
watch(topSentinelRef, (el) => {
  if (!olderObserver) return;
  olderObserver.disconnect();
  if (el) olderObserver.observe(el);
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
      <div v-if="olderAvailable" ref="topSentinelRef" class="load-older-row">
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
      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="dayDividerBefore(index)" class="day-divider" role="separator">
          <span>{{ dayDividerBefore(index) }}</span>
        </div>
        <div v-else-if="turnDividerBefore(index)" class="turn-divider" aria-hidden="true" />
        <MessageItem
          :message="message"
          :is-latest-user="message.id === latestUserId"
          :idle="!busy"
          :streaming="busy && message.id === lastMessageId && message.role === 'assistant'"
          :session-id="sessionId"
          :can-fork="!busy && message.id === lastAssistantId"
          :show-timestamp="showTimestampFor(index)"
          :work-dir="workDir ?? undefined"
          @edit="(content) => emit('edit', content)"
          @retry="emit('retry-message')"
          @fork="emit('fork')"
        />
      </template>
      <div v-if="showSkeleton" class="message-skeleton" aria-hidden="true">
        <div class="sk-body">
          <div class="sk-line sk-w-60" />
          <div class="sk-line sk-w-90" />
          <div class="sk-line sk-w-40" />
        </div>
      </div>
    </div>
    <ChatMinimap :messages="messages" :host="listRef" />
    <Transition name="scroll-btn">
      <button
        v-if="showScrollButton"
        :class="['scroll-to-bottom', { streaming: busy }]"
        title="滚动到最新消息"
        :aria-label="unreadCount > 0 ? `滚动到最新消息，${unreadCount} 条新消息` : '滚动到最新消息'"
        @click="handleScrollButtonClick"
      >
        <SvgIcon name="chevron-down" :size="18" />
        <span v-if="unreadCount > 0" class="scroll-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
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

/* Turn hairline: 1px, message-gutter left/right margins. */
.turn-divider {
  height: 1px;
  margin: var(--space-1) var(--space-5);
  background: var(--color-line);
  flex-shrink: 0;
}
/* Cross-day pill: centered, quiet. */
.day-divider {
  display: flex;
  justify-content: center;
  padding: var(--space-3) 0 0;
  flex-shrink: 0;
}
.day-divider span {
  padding: 2px 10px;
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-faint);
  font-size: 11px;
  line-height: 1.6;
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
/* Live pulse while the assistant is streaming: the FAB is the "watch it" affordance. */
.scroll-to-bottom.streaming::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-accent-bd);
  animation: scroll-pulse 1.6s var(--ease-out) infinite;
  pointer-events: none;
}
@keyframes scroll-pulse {
  0% { opacity: 0.9; transform: scale(0.92); }
  70% { opacity: 0; transform: scale(1.12); }
  100% { opacity: 0; transform: scale(1.12); }
}
.scroll-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-on-accent, #fff);
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--color-surface-raised);
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
