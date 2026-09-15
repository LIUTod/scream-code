<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onUpdated, ref, watch } from 'vue';
import type { ChatMessage } from '../types';
import MessageItem from './MessageItem.vue';
import ChatMinimap from './ChatMinimap.vue';
import { formatDayDivider, isSameLocalDay } from '../utils/timeFormat';
import { captureScrollDistance, restoreScrollTop } from '../utils/scrollAnchor';
import SvgIcon from './ui/SvgIcon.vue';

const props = withDefaults(
  defineProps<{
    messages: ChatMessage[];
    busy?: boolean;
    workDir?: string | null;
    /** Current session id - used to persist/restore the scroll position. */
    sessionId?: string;
    /** Connection state: drives the connection-lost banner. */
    connected?: boolean;
    /** Older history exists beyond the loaded window (pagination sentinel). */
    olderAvailable?: boolean;
    /** True while the parent is fetching an older page. */
    olderLoading?: boolean;
  }>(),
  { busy: false, workDir: null, sessionId: '', connected: false, olderAvailable: false, olderLoading: false },
);

const emit = defineEmits<{
  (e: 'edit', content: string): void;
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
 * Model badge collapsing. One user turn is often split into several consecutive
 * assistant segments (one per tool round — four in a real session), so repeating
 * the same model alias on each of them reads as noise. Only the first segment of a
 * consecutive assistant run shows the badge; a real model change (or an
 * interrupting user / system message) shows it again.
 *
 * Division of labour with showTimestampFor: the timestamp sits on the last segment
 * of a run ("when did this end") while the badge sits on the first ("which model
 * answered these segments") — the two never overlap.
 * A segment without a model (old snapshot / minimal segment) returns false: there
 * is no badge to show.
 * The rule only reads the full `messages` array (same as the time-grouping rule
 * above), so window slicing never changes the verdict — if the window starts
 * mid-run that run's badge lies above the window and scrolling up (the window
 * slides by pages) reveals it.
 */
function showModelFor(index: number): boolean {
  const m = props.messages[index];
  if (!m || m.role !== 'assistant' || !m.model) return false;
  const prev = props.messages[index - 1];
  if (!prev || prev.role !== 'assistant') return true;
  return prev.model !== m.model;
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

/** Per-message derived flags — mirrors the MessageItem prop surface. */
interface MessageRowFlags {
  streaming: boolean;
  isLatestUser: boolean;
  canFork: boolean;
  showTimestamp: boolean;
  /** Whether this segment shows the model badge (a run badges its first segment / a model change). */
  showModel: boolean;
  idle: boolean;
}

/**
 * Flattened render row: dividers are first-class rows so the template is a
 * single v-for over `visibleRows`, with all per-index derivation done ONCE
 * per messages change here instead of on every render inside the loop.
 * The row model always builds from the FULL messages array — windowing (P3b)
 * only slices `visibleRows` — so a divider at the window edge keeps its
 * out-of-window previous-message context.
 */
type MessageListRow =
  | { kind: 'day-divider'; key: string; dividerText: string; flags: MessageRowFlags }
  | { kind: 'turn-divider'; key: string; dividerText: null; flags: MessageRowFlags }
  | { kind: 'message'; key: string; message: ChatMessage; dividerText: null; flags: MessageRowFlags };

/** Divider rows never read flags; one shared stable object keeps memo deps cheap. */
const DIVIDER_FLAGS: MessageRowFlags = {
  streaming: false,
  isLatestUser: false,
  canFork: false,
  showTimestamp: false,
  showModel: false,
  idle: true,
};

const rows = computed<MessageListRow[]>(() => {
  const latestUser = latestUserId.value;
  const lastId = lastMessageId.value;
  const lastAsst = lastAssistantId.value;
  const out: MessageListRow[] = [];
  props.messages.forEach((message, index) => {
    const dayText = dayDividerBefore(index);
    if (dayText !== null) {
      out.push({ kind: 'day-divider', key: `${message.id}-divider`, dividerText: dayText, flags: DIVIDER_FLAGS });
    } else if (turnDividerBefore(index)) {
      out.push({ kind: 'turn-divider', key: `${message.id}-divider`, dividerText: null, flags: DIVIDER_FLAGS });
    }
    out.push({
      kind: 'message',
      key: message.id,
      message,
      dividerText: null,
      flags: {
        streaming: props.busy && message.id === lastId && message.role === 'assistant',
        isLatestUser: message.id === latestUser,
        canFork: !props.busy && message.id === lastAsst,
        showTimestamp: showTimestampFor(index),
        showModel: showModelFor(index),
        idle: !props.busy,
      },
    });
  });
  return out;
});

/* ── Render window (P3b) ─────────────────────────────────────────────────
 * `windowStart` is the index of the first rendered row in the FULL row model.
 * A tail-aligned window holds WINDOW_SIZE rows (a 300-message conversation
 * mounts 80 rows, not 300) and it is trimmed at the TOP only — the bottom is
 * never cut — so the last row is always in the DOM and the existing
 * "scroll to bottom / unread badge / streaming pin" semantics keep working
 * untouched. Paging up lowers `windowStart` and the window grows upward,
 * bounded by the row model: the user only ever pays DOM for the history they
 * actually look at.
 */
const WINDOW_SIZE = 80;
/** Rows revealed per sentinel trigger when paging up through loaded rows. */
const PAGE = 40;
/** Rows of breathing room kept ABOVE a row revealed from the minimap. */
const REVEAL_LEAD = 8;

/** Tail-aligned start for a row model of `total` rows. */
function tailStart(total: number): number {
  return Math.max(0, total - WINDOW_SIZE);
}

const windowStart = ref(tailStart(rows.value.length));

/**
 * The template iterates THIS, never `rows`. Slicing is a pure render cut: the
 * row model (and therefore every day/turn divider, including the one at the
 * window edge) is still computed from the FULL messages array.
 */
const visibleRows = computed<MessageListRow[]>(() => {
  const total = rows.value.length;
  const start = Math.min(Math.max(0, windowStart.value), total);
  return rows.value.slice(start);
});

/**
 * The top sentinel is the paging trigger for BOTH sources of older content:
 * rows still above the window (pure slide) and an unloaded older page (REST).
 */
const showTopSentinel = computed(() => windowStart.value > 0 || props.olderAvailable);

/** Row index holding `id` in the full row model, or -1. */
function rowIndexOfMessage(id: string): number {
  const list = rows.value;
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    if (r.kind === 'message' && r.message.id === id) return i;
  }
  return -1;
}

/**
 * Slide the render window so the row for `id` exists in the DOM. Returns false
 * when the id is not in the row model at all. Used by the minimap, whose
 * segments map the messages ARRAY (not the DOM) and can therefore point at a
 * row that windowing has not rendered yet.
 */
function revealMessage(id: string): boolean {
  const index = rowIndexOfMessage(id);
  if (index < 0) return false;
  if (index >= windowStart.value) return true; // already rendered
  anchorWindowMove(() => {
    windowStart.value = Math.max(0, index - REVEAL_LEAD);
  });
  return true;
}

/**
 * Apply a window move while keeping the viewport pinned to the same content:
 * capture the distance-to-content-end before Vue patches the DOM, restore it
 * after. Equivalent to shifting `scrollTop` by the inserted height, which is
 * exactly what a top-slide does.
 */
function anchorWindowMove(move: () => void): void {
  const el = listRef.value;
  if (!el) {
    move();
    return;
  }
  const distance = captureScrollDistance(el.scrollHeight, el.scrollTop);
  move();
  nextTick(() => {
    const box = listRef.value;
    if (box) box.scrollTop = restoreScrollTop(box.scrollHeight, distance);
  });
}

/**
 * Set by the prepend watcher (registered BEFORE the window watcher, so it runs
 * first in the same flush) for the current flush: rows appeared above the
 * window, so the window watcher must not tail-follow them.
 */
let preInsertHandled = false;

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

/**
 * Follow threshold (px): anything closer to the content bottom than this counts as
 * "at the bottom". Deliberately tightened from 80 to 24px — the wider the sticky
 * zone, the easier follow-scroll yanks a user who is merely near the bottom.
 */
const FOLLOW_THRESHOLD = 24;

function isNearBottom(): boolean {
  const el = listRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToBottom(behavior: ScrollBehavior): void {
  // "Go to bottom" always re-arms the tail window first, so the newest rows
  // exist in the DOM before the scroll lands (P3b).
  windowStart.value = tailStart(rows.value.length);
  // Wait for the DOM update, then scroll. rAF is more reliable than
  // nextTick for read-after-write scroll offsets.
  requestAnimationFrame(() => {
    const el = listRef.value;
    if (!el) return;
    const finalBehavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : behavior;
    if (finalBehavior === 'smooth') beginSmoothScroll();
    el.scrollTo({ top: el.scrollHeight, behavior: finalBehavior });
  });
}

/* ── Inertia guard ────────────────────────────────────────────────────────────
 * While a smooth follow scroll (scrollToBottom('smooth')) is in flight a wheel /
 * touch input must freeze the animation and hand scrolling back to the reader —
 * otherwise the browser layers user input on top of the follow animation and it
 * feels like the page is fighting the hand. The flag clears on scrollend; a lost
 * scrollend (interrupted animation) falls back to a timeout so the flag can never
 * leak into "smooth scrolling permanently off".
 */
let smoothInFlight = false;
let smoothEndHandler: (() => void) | null = null;
let smoothEndTimer: ReturnType<typeof setTimeout> | null = null;

function endSmoothScroll(): void {
  const el = listRef.value;
  if (smoothEndHandler && el) el.removeEventListener('scrollend', smoothEndHandler);
  smoothEndHandler = null;
  smoothInFlight = false;
  if (smoothEndTimer !== null) {
    clearTimeout(smoothEndTimer);
    smoothEndTimer = null;
  }
}

function beginSmoothScroll(): void {
  const el = listRef.value;
  if (!el) return;
  endSmoothScroll(); // Re-entrancy: drop the previous listener/timer before arming a new one.
  smoothInFlight = true;
  smoothEndHandler = () => endSmoothScroll();
  el.addEventListener('scrollend', smoothEndHandler);
  smoothEndTimer = setTimeout(endSmoothScroll, 1500);
}

/**
 * User input takes over: freeze an in-flight smooth animation where it is. Later
 * scroll events go through the normal onScroll judgement.
 */
function onUserScrollInput(): void {
  const el = listRef.value;
  if (!smoothInFlight || !el) return;
  // behavior:'auto' interrupts an in-flight smooth animation immediately (browser semantics).
  el.scrollTo({ top: el.scrollTop, behavior: 'auto' });
  endSmoothScroll();
}

let saveScrollRaf: number | null = null;

/**
 * ResizeObserver follow: height growth that never passes through the
 * messages.length/streamLength watcher (image load, font load, thinking block
 * expanding) still gets one scroll-to-bottom while the view follows (at the bottom
 * or pinned), so the viewport does not stop half way. It fires only when
 * scrollHeight grows and relies on the baseline / rAF coalescing / guards below to
 * avoid yanking.
 */
let resizeObserver: ResizeObserver | null = null;
/** Content height seen by the previous callback; the first observe callback calibrates the baseline. */
let lastObservedHeight = 0;
/** rAF coalescing flag for RO-triggered scrolls (one height jump must not fire several scrollToBottom calls). */
let roScrollRaf: number | null = null;

/** Row elements currently observed: added/removed incrementally so a re-render never rebuilds the set. */
const observedResizeTargets = new Set<Element>();

/**
 * Aim the observers at the row elements inside the container (called after a DOM
 * patch). ResizeObserver only fires when the *observed element's box* changes, and
 * `.message-list` is a fixed-height flex:1; min-height:0 scroll box — growing
 * content only changes scrollHeight while the container box never moves, so the old
 * observe(scroll container) received nothing but the initial callback and the
 * "image / font / thinking expansion" height blind spot was never actually covered.
 * The row elements (MessageItem root / divider / skeleton / sentinels) are the ones
 * that really resize.
 * The row set changes with window sliding and message add/remove, so every patch
 * re-aims the observers; only the difference is applied, so during steady state
 * (streaming text inside a row) the observed set is unchanged → zero overhead.
 */
function syncResizeTargets(): void {
  const ro = resizeObserver;
  const el = listRef.value;
  if (!ro || !el) return;
  const current = new Set<Element>(Array.from(el.children));
  for (const target of Array.from(observedResizeTargets)) {
    if (current.has(target)) continue;
    ro.unobserve(target);
    observedResizeTargets.delete(target);
  }
  for (const target of current) {
    if (observedResizeTargets.has(target)) continue;
    ro.observe(target);
    observedResizeTargets.add(target);
  }
}

function onListResize(): void {
  const el = listRef.value;
  if (!el) return;
  const height = el.scrollHeight;
  const grew = height > lastObservedHeight;
  lastObservedHeight = height;
  if (!grew) return;
  // No pulling to the bottom while a prepend is anchored: prepend / window sliding
  // have their own viewport correction (a nextTick shift) and take precedence here.
  // (Both flags are normally already consumed within the same flush; this is a
  // defensive check.)
  if (justPrepended || preInsertHandled) return;
  if (!(forceScroll || isNearBottom())) return;
  if (roScrollRaf !== null) return;
  roScrollRaf = requestAnimationFrame(() => {
    roScrollRaf = null;
    scrollToBottom('auto');
  });
}

/**
 * Anchor key (v3): the server journal's seq is stable across refresh / reconnect /
 * session switch, so the key is the `role:seq` pair (role disambiguates: a skeleton
 * message and the user echo it answers can share one seq). A message without a seq
 * only has the frontend random id — valid within this page session only — and
 * degrades to `id:<random id>`, which never matches after a refresh; the caller then
 * falls back to the bottom (a tail read position is already at the bottom, so the
 * degradation is harmless; a history read position always has a seq).
 */
function anchorKeyOf(message: ChatMessage): string {
  return message.seq !== undefined ? `${message.role}:${message.seq}` : `id:${message.id}`;
}

/** Find the current message by anchor key (shared by v2/v3 restore and save); null when absent. */
function findMessageByKey(key: string): ChatMessage | null {
  for (const message of props.messages) {
    if (anchorKeyOf(message) === key) return message;
  }
  return null;
}

/**
 * First message row below the viewport top (MessageItem roots carry data-message-id).
 * Divider rows cannot anchor: their text changes with the date / run, whereas a
 * message row is always locatable.
 * With no layout (jsdom) every offsetTop is 0 and no anchor is found → null (nothing
 * is written).
 */
function findAnchorRow(el: HTMLElement): { id: string; offsetTop: number } | null {
  const rowEls = el.querySelectorAll<HTMLElement>('[data-message-id]');
  for (const rowEl of rowEls) {
    if (rowEl.offsetTop + rowEl.offsetHeight > el.scrollTop) {
      const id = rowEl.dataset.messageId;
      if (id) return { id, offsetTop: rowEl.offsetTop };
    }
  }
  return null;
}

/** Persist the current scroll position (rAF-coalesced) for session switches/refresh. */
function saveScrollPosition(): void {
  const el = listRef.value;
  const sid = props.sessionId;
  if (!el || !sid) return;
  if (saveScrollRaf !== null) return;
  saveScrollRaf = requestAnimationFrame(() => {
    saveScrollRaf = null;
    try {
      // v3 anchor format: stable anchor key (seq) + offset of the row top from the
      // viewport top. Restore slides the window to the anchor first and then locates
      // the row, so the window never has to expand to the full list (hundreds of DOM
      // rows) just to reach an absolute offset. v2 keyed on the frontend random id,
      // which is entirely new after a refresh / reconnect → restore always missed.
      const anchor = findAnchorRow(el);
      if (!anchor) return;
      const message = props.messages.find((m) => m.id === anchor.id);
      const key = message ? anchorKeyOf(message) : `id:${anchor.id}`;
      localStorage.setItem(`scream-scroll:${sid}`, `v3:${key}:${Math.round(anchor.offsetTop - el.scrollTop)}`);
    } catch {
      // Best-effort.
    }
  });
}

/**
 * Restore outcome: restored = positioned; missing = no entry for this session;
 * unusable = an entry exists but does not match anything.
 */
type ScrollRestoreResult = 'restored' | 'missing' | 'unusable';

/** Whether this session has a saved read position (sync probe, deciding the async-restore branch). */
function hasSavedScrollEntry(sid: string): boolean {
  try {
    return localStorage.getItem(`scream-scroll:${sid}`) !== null;
  } catch {
    return false;
  }
}

/**
 * First-paint tail alignment (a brand-new session with no saved entry): re-align the
 * tail window and write straight to the bottom.
 * Deliberately not reusing scrollToBottom(): that one waits on a rAF, so it lands
 * after user scroll input arriving past the call (taking a viewport the user just
 * took over back to the bottom). This runs from nextTick after the DOM patch of the
 * same flush, so writing scrollTop directly is the final position.
 */
function alignViewportToTail(): void {
  windowStart.value = tailStart(rows.value.length);
  const box = listRef.value;
  if (box) box.scrollTop = box.scrollHeight;
}

/**
 * Pin the viewport back to an anchor row: slide the window so the row is in the DOM,
 * then position by "row top - saved offset".
 * If the row is not in the current messages (reveal failed) or never rendered, the
 * result is unusable — never a silent stop at the window top; the caller falls back
 * to the bottom.
 */
async function restoreToRow(messageId: string, offset: number): Promise<ScrollRestoreResult> {
  if (!revealMessage(messageId)) return 'unusable';
  await nextTick();
  const box = listRef.value;
  if (!box) return 'unusable';
  const rowEl = Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (n) => n.dataset.messageId === messageId,
  );
  if (!rowEl) return 'unusable';
  box.scrollTop = rowEl.offsetTop - offset;
  return 'restored';
}

/**
 * Read and apply the saved read position. All three outcomes are returned
 * explicitly: a mismatch must have a fallback (the bottom) — no "comment claims a
 * fallback to the bottom while the code returns early".
 */
async function restoreScrollPosition(): Promise<ScrollRestoreResult> {
  const el = listRef.value;
  const sid = props.sessionId;
  if (!el || !sid) return 'missing';
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(`scream-scroll:${sid}`);
  } catch {
    // Best-effort.
  }
  if (!saved) return 'missing';
  // v3: anchor key = stable identity (role:seq), reproducible across refresh / session switch.
  if (saved.startsWith('v3:')) {
    const body = saved.slice(3);
    // The key itself may contain ':' (role:seq / id:msg_…), so the offset is always the last segment.
    const sep = body.lastIndexOf(':');
    if (sep <= 0) return 'unusable';
    const key = body.slice(0, sep);
    const offset = Number(body.slice(sep + 1));
    if (!Number.isFinite(offset)) return 'unusable';
    const target = findMessageByKey(key);
    if (!target) return 'unusable';
    return restoreToRow(target.id, offset);
  }
  // v2 (old format, frontend random id) is still read: the id stays valid for in-page session switches without a refresh.
  if (saved.startsWith('v2:')) {
    const parts = saved.split(':');
    const messageId = parts[1];
    const offset = Number(parts[2]);
    if (!messageId || !Number.isFinite(offset)) return 'unusable';
    if (!props.messages.some((m) => m.id === messageId)) return 'unusable';
    return restoreToRow(messageId, offset);
  }
  // The oldest format (a plain absolute scrollTop number) keeps its original logic.
  const top = Number(saved);
  if (!Number.isFinite(top)) return 'unusable';
  // A saved 0 means "parked at the top": respect it, move nothing and do not treat it as stale.
  if (!(top > 0)) return 'restored';
  // Windowed restore: the saved offset is absolute-top against the FULL list,
  // but the tail window may not contain that far up — the browser would
  // silently clamp to the bottom and the read position is lost. Expand the
  // window upward so the position becomes reachable, then restore exactly.
  if (top > el.scrollHeight - el.clientHeight && windowStart.value > 0) {
    windowStart.value = 0;
    await nextTick();
    const box = listRef.value;
    if (box) box.scrollTop = top;
    return 'restored';
  }
  el.scrollTop = top;
  return 'restored';
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
  () => [props.messages[0]?.id ?? null, props.messages.length, props.sessionId] as const,
  ([firstId, len, sid], [prevFirstId, prevLen, prevSid]) => {
    // Pre-insert test: the row model is rebuilt from `props.messages`, so a
    // growth in length whose FIRST id also changed — WITHIN THE SAME SESSION —
    // means rows appeared ABOVE (an older page was prepended). A plain append
    // keeps the first id; a session switch changes sessionId and is excluded
    // explicitly (a fresh conversation can otherwise look like a pre-insert).
    const prepended =
      len > 0 &&
      firstId !== null &&
      prevFirstId !== null &&
      firstId !== prevFirstId &&
      len > (prevLen ?? 0) &&
      sid === prevSid;
    justPrepended = prepended;
    if (!prepended) return;
    // The window is NOT re-anchored here: `visibleRows` starts at
    // `windowStart`, and a pre-insert pushes existing rows to higher indices,
    // so everything previously rendered stays rendered and the freshly loaded
    // rows appear ABOVE it. The user keeps their place; the sentinel simply
    // moves off-screen until they scroll up again.
    preInsertHandled = true;
    // Capture the pre-patch scrollHeight now (pre-order watcher, Vue has not
    // patched the DOM yet) and shift by the inserted height after the patch.
    const el = listRef.value;
    if (!el) return;
    const distance = captureScrollDistance(el.scrollHeight, el.scrollTop);
    nextTick(() => {
      el.scrollTop = restoreScrollTop(el.scrollHeight, distance);
    });
  },
);

/**
 * Window maintenance on row-model growth. Registered AFTER the prepend
 * watcher, so on a pre-insert flush the watcher above has already marked the
 * flush via `preInsertHandled` (tail-following a history page the user pulled
 * in would yank them to the bottom).
 * - tail-aligned -> stay glued to the tail as new messages arrive;
 * - start past the tail line (list shrank or was replaced) -> clamp to the tail;
 * - scrolled up into history -> leave `windowStart` alone, so incoming
 *   messages never move what the user is reading.
 */
watch(
  () => rows.value.length,
  (len, oldLen) => {
    const prevLen = oldLen ?? 0;
    if (preInsertHandled) {
      preInsertHandled = false;
      return;
    }
    // Tail-follow needs BOTH signals: the window glued to the tail AND the
    // viewport near the bottom. Window alignment alone would let a new
    // message slide the window while the user reads rows above it inside
    // the current window — unmounting what they are looking at.
    // showScrollButton is the existing "away from bottom by >FOLLOW_THRESHOLD" signal
    // maintained by onScroll (same threshold as the unread-badge logic).
    const wasTailAligned =
      windowStart.value === tailStart(prevLen) && !showScrollButton.value;
    if (wasTailAligned) {
      windowStart.value = tailStart(len);
    } else if (windowStart.value > tailStart(len)) {
      // Shrink clamp (list trimmed/reset): anchor the viewport so a user who
      // paged up is not yanked by the window snapping to the new tail.
      anchorWindowMove(() => {
        windowStart.value = tailStart(len);
      });
    }
  },
);

function onScroll(): void {
  const el = listRef.value;
  if (!el) return;
  const awayFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_THRESHOLD;
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
    // A new conversation always opens tail-aligned (P3b); rows for the new
    // session may arrive with the same length as the old one, so the
    // length-based watcher alone would not re-arm the window.
    windowStart.value = tailStart(rows.value.length);
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
        // Empty → non-empty means first paint (refresh / session switch): no entry or
        // a mismatching entry both align to the bottom, never a silent stop at the
        // window top. Appending inside a session (oldLen > 0) keeps the old
        // semantics: try the saved position once, never pull the user away.
        const firstPaint = (oldLen ?? 0) === 0;
        if (firstPaint && !hasSavedScrollEntry(props.sessionId)) {
          // Brand-new session (nothing ever stored locally): no target to restore, so
          // align to the tail. Sync decision + same-flush landing — an async restore
          // chain would land after the user's next scroll input and take the viewport
          // back to the bottom.
          void nextTick(alignViewportToTail);
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(async () => {
          const result = await restoreScrollPosition();
          if (result === 'restored') return;
          if (firstPaint || result === 'unusable') alignViewportToTail();
        }));
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
  // Inertia guard: while a smooth follow scroll is in flight user scroll input takes over (passive, so the input itself is not blocked).
  listRef.value?.addEventListener('wheel', onUserScrollInput, { passive: true });
  listRef.value?.addEventListener('touchstart', onUserScrollInput, { passive: true });
  // Auto-load older history: the sentinel sits above the first message, so it
  // is only visible when the user has scrolled to the top of the window.
  if (typeof IntersectionObserver !== 'undefined') {
    olderObserver = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        // ① Rows already in the row model but above the window: pure slide,
        //    no network. Anchored so the view does not jump.
        if (windowStart.value > 0) {
          anchorWindowMove(() => {
            windowStart.value = Math.max(0, windowStart.value - PAGE);
          });
        }
        // ② Ask the server for an older page ONLY once the row model itself
        //    is exhausted (window slid to 0). Fetching while ① still has
        //    unseen rows above would prefetch pages the user never sees and
        //    re-trigger the sentinel in a cascade.
        if (
          windowStart.value === 0 &&
          props.olderAvailable &&
          !props.olderLoading &&
          props.messages.length > 0
        ) {
          emit('load-older');
        }
      },
      { root: listRef.value, rootMargin: '120px 0px 0px 0px' },
    );
    if (topSentinelRef.value) olderObserver.observe(topSentinelRef.value);
  }
  // Height-growth blind spot (image / font / thinking expansion never reaches the
  // message watcher): one scroll-to-bottom while content grows and the view follows.
  // The pre-observe baseline keeps the first callback (initial size report) inert.
  if (typeof ResizeObserver !== 'undefined') {
    lastObservedHeight = listRef.value?.scrollHeight ?? 0;
    resizeObserver = new ResizeObserver(onListResize);
    syncResizeTargets();
  }
  // The row set changes with window sliding / message add-remove: re-aim the observers after every DOM patch.
  // onUpdated instead of watch(visibleRows, …, {flush:'post'}) — the latter queues an
  // extra job with the same id and disturbs the existing registration order (the
  // prepend watcher must run before the rows-length watcher, or the top history page
  // loses its viewport anchoring).
  onUpdated(() => syncResizeTargets());
  // Refresh recovery: restore the saved scroll position once rendered. An entry that
  // exists but does not match (message ids replaced, target row no longer in the
  // window) must fall back to the bottom — otherwise opening a session stops at the
  // window top with a silently lost read position.
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    if ((await restoreScrollPosition()) === 'unusable') alignViewportToTail();
  }));
});

onUnmounted(() => {
  listRef.value?.removeEventListener('scroll', onScroll);
  listRef.value?.removeEventListener('wheel', onUserScrollInput);
  listRef.value?.removeEventListener('touchstart', onUserScrollInput);
  olderObserver?.disconnect();
  olderObserver = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  observedResizeTargets.clear();
  if (roScrollRaf !== null) {
    cancelAnimationFrame(roScrollRaf);
    roScrollRaf = null;
  }
  endSmoothScroll();
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
      <!-- Top sentinel: doubles as the window slide trigger (P3b), so it is
           rendered whenever rows exist above the window, not only when the
           server has an older page. -->
      <div v-if="showTopSentinel" ref="topSentinelRef" class="load-older-row">
        <button v-if="olderAvailable" class="load-older-btn" :disabled="olderLoading" @click="emit('load-older')">
          {{ olderLoading ? '加载中…' : '加载更早消息' }}
        </button>
      </div>
      <!-- An empty journal no longer renders a guide hero: with lazy session creation
           an empty session only exists in the transient "send in flight" state (user
           message queued, reply pending), and the skeleton below says "starting" well
           enough — keep this blank. -->
      <!--
        v-memo freezes a row's subtree when none of its deps change, so a
        flush/parent re-render skips re-creating MessageItem vnodes (~N-1/N of
        the list). Deps MUST stay in sync with everything the row renders:
        every `row.*` field, every reactive scalar passed to MessageItem
        (busy, sessionId, workDir — handlers/emit are stable references), and
        ANY NEW derived prop added to a row must be appended here too.
      -->
      <template
        v-for="row in visibleRows"
        :key="row.key"
        v-memo="[row.message, row.flags.streaming, row.flags.isLatestUser, row.flags.canFork, row.flags.showTimestamp, row.flags.showModel, row.flags.idle, row.dividerText, busy, sessionId, workDir]"
      >
        <div v-if="row.kind === 'day-divider'" class="day-divider" role="separator">
          <span>{{ row.dividerText }}</span>
        </div>
        <div v-else-if="row.kind === 'turn-divider'" class="turn-divider" aria-hidden="true" />
        <MessageItem
          v-else
          :message="row.message"
          :is-latest-user="row.flags.isLatestUser"
          :idle="row.flags.idle"
          :streaming="row.flags.streaming"
          :session-id="sessionId"
          :can-fork="row.flags.canFork"
          :show-timestamp="row.flags.showTimestamp"
          :show-model="row.flags.showModel"
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
    <ChatMinimap
      :messages="messages"
      :host="listRef"
      :revision="windowStart"
      :reveal-message="revealMessage"
    />
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
  /* D4: the chat scroll area hides its scrollbar (wheel / touch still work; other
     panels keep the global 4px hairline track). */
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  padding: var(--space-3) 0 var(--space-2);
  overscroll-behavior: contain;
  background: var(--color-surface);
}
.message-list::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
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
