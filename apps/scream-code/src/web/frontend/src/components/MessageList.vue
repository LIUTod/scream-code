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
  }>(),
  { busy: false, workDir: null, sessionId: '', model: null, contextUsage: null, connected: false },
);

const emit = defineEmits<{
  (e: 'edit', content: string): void;
  (e: 'pick', text: string): void;
}>();

const listRef = ref<HTMLElement | null>(null);

const latestUserId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i]!.role === 'user') return props.messages[i]!.id;
  }
  return null;
});

const lastMessageId = computed(() => props.messages.at(-1)?.id ?? null);

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
    <div ref="listRef" class="message-list">
      <EmptyState
        v-if="messages.length === 0"
        :work-dir="workDir"
        :model="model"
        :context-usage="contextUsage"
        :connected="connected"
        @pick="(t) => emit('pick', t)"
      />
      <MessageItem
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :is-latest-user="message.id === latestUserId"
        :idle="!busy"
        :streaming="busy && message.id === lastMessageId && message.role === 'assistant'"
        @edit="(content) => emit('edit', content)"
      />
      <div v-if="showSkeleton" class="message-skeleton" aria-hidden="true">
        <div class="sk-avatar" />
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

.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 12px 0 8px;
  overscroll-behavior: contain;
  background: var(--color-surface);
}

.scroll-to-bottom {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--color-line);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  z-index: 10;
  transition: background 0.15s, color 0.15s;
}

.scroll-to-bottom:hover {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.scroll-btn-enter-active,
.scroll-btn-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.scroll-btn-enter-from,
.scroll-btn-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* Skeleton loading placeholder */
.message-skeleton {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  animation: sk-in var(--dur-base) var(--ease-out) both;
}
@keyframes sk-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.sk-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
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
.sk-avatar,
.sk-line {
  background: linear-gradient(
    90deg,
    var(--color-surface) 25%,
    var(--color-surface-raised) 50%,
    var(--color-surface) 75%
  );
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s linear infinite;
}
@keyframes sk-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .sk-avatar,
  .sk-line {
    animation: none;
  }
}
</style>
