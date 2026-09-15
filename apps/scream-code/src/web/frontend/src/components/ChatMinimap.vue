<!-- G5.1 ChatMinimap.
     A thin progress strip on the right edge of the message column. It derives
     everything from the visible ChatMessage[] (seq/role/content) plus the live
     metrics of the host scroll box — there is no dedicated endpoint, so no new
     backend surface is needed.
     Two layers, deliberately quiet under the continuous one:
     - Density underlay: blocks colored by role (user / assistant / tool), height
       proportional to content length. Decorative ("where is this conversation
       dense"), and still clickable: click a block -> reveal + scrollIntoView.
     - Position thumb: one capsule whose top/height map scrollTop/scrollHeight,
       i.e. the same geometry a native scrollbar thumb uses. This replaces the
       old IntersectionObserver per-row highlight, which stepped block by block
       and read as a jump rather than as motion.
     - The thumb wakes on scroll/hover and fades out after ~1s of stillness.
     - Shown only when the content actually overflows, and only at >= 960px. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import type { ChatMessage } from '../types';

const props = defineProps<{
  messages: ChatMessage[];
  /** The scroll/viewport container that holds the message rows. */
  host: HTMLElement | null;
  /**
   * Render-window revision of the parent list (its window start). The list is
   * windowed, so the scrollable range changes when the window slides even
   * though the viewport did not scroll; bumping this re-measures the mapping.
   */
  revision?: number;
  /**
   * Ask the parent list to slide its render window over `id` so a DOM row
   * exists before we try to scroll to it. Returns false when the id is unknown.
   */
  revealMessage?: (id: string) => boolean;
}>();

const hoverSeq = ref<number | null>(null);

const MIN_WIDTH_QUERY = '(min-width: 960px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const hasMatchMedia = typeof window.matchMedia === 'function';
const mql = hasMatchMedia ? window.matchMedia(MIN_WIDTH_QUERY) : null;
const motionMql = hasMatchMedia ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
const enabled = ref(mql?.matches ?? false);
/**
 * Under reduced motion the thumb stays visible (it is only hidden until the
 * first frame is ready). "Always visible" beats "instant switch": one less
 * fade-out timer branch in JS, and no CSS override rules for a 0ms transition.
 */
const reducedMotion = ref(motionMql?.matches ?? false);

function onMql(e: MediaQueryListEvent): void {
  enabled.value = e.matches;
}
function onMotionMql(e: MediaQueryListEvent): void {
  reducedMotion.value = e.matches;
}
onMounted(() => mql?.addEventListener('change', onMql));
onBeforeUnmount(() => mql?.removeEventListener('change', onMql));
onMounted(() => motionMql?.addEventListener('change', onMotionMql));
onBeforeUnmount(() => motionMql?.removeEventListener('change', onMotionMql));

/* ── Density underlay ───────────────────────────────────────────────────── */
interface Segment {
  id: string;
  seq: number;
  role: string;
  ratio: number;
  offset: number; // top % within the strip
}

/** Heuristic height per message: grows monotonically with content length,
 *  saturating toward 1.0 (0.2 floor keeps tiny messages clickable). */
function contentRatio(m: ChatMessage): number {
  const len = m.content?.length ?? 0;
  if (len <= 0) return 0.2;
  return 0.2 + 0.8 * (1 - 1 / (1 + len / 200));
}

const segments = computed<Segment[]>(() => {
  let acc = 0;
  return props.messages.map((m, i) => {
    const ratio = contentRatio(m);
    const seg: Segment = {
      id: m.id ?? `seq-${i}`,
      seq: m.seq ?? i,
      role: m.role ?? 'tool',
      ratio,
      offset: acc,
    };
    acc += ratio;
    return seg;
  });
});

const totalRatio = computed(() => segments.value.reduce((s, x) => s + x.ratio, 0) || 1);

/* ── Continuous thumb ───────────────────────────────────────────────────── */
interface Metrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Pixel height the thumb is mapped into (the strip's own box). */
  trackHeight: number;
}

const metrics = ref<Metrics>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, trackHeight: 0 });
/** No thumb is drawn before the first frame measures real metrics: after a session switch a stale mapping would fling the pill to the wrong place and flicker. */
const ready = ref(false);
const hovering = ref(false);
const quiet = ref(false);
const trackRef = ref<HTMLElement | null>(null);

/** When the content fits on one screen the minimap has no position information to express, so it is not rendered at all. */
const scrollable = computed(() => metrics.value.scrollHeight > metrics.value.clientHeight);

const MIN_THUMB_PX = 24;

/**
 * Linear mapping: top = scrollTop/scrollHeight, height ∝ clientHeight/scrollHeight.
 * When the 24px minimum visible height kicks in, top is clamped back inside the
 * track so the pill stays flush at the bottom when scrolled to the end.
 */
const thumbStyle = computed<CSSProperties>(() => {
  const { scrollTop, scrollHeight, clientHeight, trackHeight } = metrics.value;
  if (!ready.value || !scrollable.value || trackHeight <= 0) return {};
  const h = Math.max(MIN_THUMB_PX, (clientHeight / scrollHeight) * trackHeight);
  const span = Math.max(trackHeight - h, 0);
  const top = Math.min(Math.max((scrollTop / scrollHeight) * trackHeight, 0), span);
  return { top: `${top}px`, height: `${h}px` };
});

/** Hover test: besides pointerenter, hovering a segment tooltip counts too — either one means hovered. */
const hovered = computed(() => hovering.value || hoverSeq.value !== null);

/** Fade test: never fade under reduced motion, or while the pointer rests on the minimap. */
const isQuiet = computed(() => quiet.value && !hovered.value && !reducedMotion.value);

/** How long the pill stays idle before fading. Much longer than the transition itself, so it stays visible between scrolls. */
const QUIET_MS = 1000;
let quietTimer: ReturnType<typeof setTimeout> | null = null;

function wake(): void {
  quiet.value = false;
  if (reducedMotion.value) return;
  if (quietTimer !== null) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    quiet.value = true;
  }, QUIET_MS);
}

function clearQuietTimer(): void {
  if (quietTimer === null) return;
  clearTimeout(quietTimer);
  quietTimer = null;
}

let rafId: number | null = null;

function measure(): void {
  const host = props.host;
  if (!host) {
    ready.value = false;
    return;
  }
  // The track's own height wins; when unmounted or unlaid-out (jsdom) fall back
  // to the viewport height — the two are nearly equal in a real browser, and the
  // fallback only exists so a measurement always has a definite mapping basis.
  const track = trackRef.value?.clientHeight ?? 0;
  metrics.value = {
    scrollTop: host.scrollTop,
    scrollHeight: host.scrollHeight,
    clientHeight: host.clientHeight,
    trackHeight: track || host.clientHeight,
  };
  ready.value = host.scrollHeight > 0;
}

/** rAF coalescing: several scroll/resize callbacks in one frame measure once, and rAF runs before the next frame paints. */
function schedule(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    measure();
  });
}

function onScroll(): void {
  wake();
  schedule();
}

/** Entering the minimap: appear immediately and push the fade timer back; leaving grants the same 1s grace. */
function onStripEnter(): void {
  hovering.value = true;
  wake();
}

function onStripLeave(): void {
  hovering.value = false;
  wake();
}

let resizeObserver: ResizeObserver | null = null;

function bindSource(): void {
  const host = props.host;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (!host) return;
  host.addEventListener('scroll', onScroll, { passive: true });
  // Viewport/column size changes are only reported through ResizeObserver (no
  // scroll event); taller content is covered by the messages/revision/totalRatio
  // watchers below.
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => schedule());
    resizeObserver.observe(host);
  }
}

function unbindSource(): void {
  props.host?.removeEventListener('scroll', onScroll);
  resizeObserver?.disconnect();
  resizeObserver = null;
}

onMounted(() => {
  if (enabled.value) {
    bindSource();
    wake();
    schedule();
  }
});
onBeforeUnmount(() => {
  unbindSource();
  clearQuietTimer();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
});

// A new scroll-source element (remount) or hiding on a narrow screen invalidates
// the old mapping: unbind, rebind and re-measure.
watch(
  [() => props.host, enabled],
  () => {
    unbindSource();
    ready.value = false;
    nextTick(() => {
      if (!enabled.value) return;
      bindSource();
      schedule();
    });
  },
);

/**
 * Session switch vs. paging older messages: both replace the first message, but
 * only a switch invalidates the old mapping completely (head and tail both
 * change). When paging, scrollTop is anchored by the parent list and the
 * geometry is continuous, so going through opacity:0 would be a visible flicker.
 * The test is therefore "head and tail both changed", which is exactly what a
 * switch looks like.
 */
const headTail = computed(() => `${props.messages[0]?.id ?? ''}|${props.messages.at(-1)?.id ?? ''}`);
let lastHead = '';
let lastTail = '';
watch(
  headTail,
  (next) => {
    const [head, tail] = next.split('|');
    const switched = lastHead !== '' && head !== lastHead && tail !== lastTail;
    lastHead = head ?? '';
    lastTail = tail ?? '';
    if (switched) ready.value = false; // stale mapping — re-enter from opacity 0
    schedule();
  },
  { immediate: true },
);

// The strip itself only exists once scrollable turns true, so the first
// measurement has to fall back to the viewport height; measure again after it
// renders to get the real track height, so the mapping lines up exactly with the
// visible 6px strip.
watch(scrollable, (on) => {
  if (on) nextTick(schedule);
});

/**
 * Three sources of change in the scrollable range: a change in row count,
 * windowed sliding (revision), and — while streaming — the same batch of messages
 * growing (totalRatio changes, row count does not). Any of them triggers
 * another measurement, all through the same rAF coalescing channel, so there is
 * at most one DOM read per frame.
 */
watch([() => props.messages.length, () => props.revision, totalRatio, enabled], () => {
  schedule();
});

function scrollToMessage(id: string): void {
  const host = props.host;
  if (!host) return;
  // Segments map the full messages array, but only the windowed rows are in
  // the DOM: slide the parent's window over the target first, then scroll once
  // the row exists.
  props.revealMessage?.(id);
  const selector = `[data-message-id="${CSS.escape(id)}"]`;
  const jump = () => {
    host.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (host.querySelector(selector)) jump();
  else void nextTick(jump);
}

function tooltipOf(seg: Segment): string {
  const role = seg.role === 'user' ? '用户' : seg.role === 'assistant' ? '助手' : '工具';
  return `#${seg.seq} ${role}`;
}
</script>

<template>
  <div
    v-if="enabled && segments.length > 0 && scrollable"
    class="minimap"
    :class="{ 'is-quiet': isQuiet, 'is-hovered': hovered }"
    role="navigation"
    aria-label="消息地图"
    @pointerenter="onStripEnter"
    @pointerleave="onStripLeave"
  >
    <div ref="trackRef" class="minimap-track">
      <button
        v-for="seg in segments"
        :key="seg.id"
        class="minimap-block"
        :class="`role-${seg.role}`"
        :style="{
          top: `${(seg.offset / totalRatio) * 100}%`,
          height: `${Math.max((seg.ratio / totalRatio) * 100, 2)}%`,
        }"
        :title="tooltipOf(seg)"
        :aria-label="tooltipOf(seg)"
        @mouseenter="hoverSeq = seg.seq"
        @mouseleave="hoverSeq = null"
        @click="scrollToMessage(seg.id)"
      >
        <span v-if="hoverSeq === seg.seq" class="minimap-tooltip">{{ tooltipOf(seg) }}</span>
      </button>
      <div class="minimap-thumb" :style="thumbStyle" :class="{ 'is-ready': ready }" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.minimap {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 6px;
  z-index: var(--z-dock);
  pointer-events: none;
}
.minimap-track {
  position: relative;
  width: 100%;
  height: 100%;
}
/* Background texture: expresses density only and takes no part in position highlighting, so the contrast is kept near decorative level and only brightens on hover. */
.minimap-block {
  position: absolute;
  left: 0;
  width: 100%;
  border: none;
  border-radius: var(--radius-full);
  padding: 0;
  cursor: pointer;
  pointer-events: auto;
  opacity: 0.18;
}
.minimap-block:hover {
  opacity: 0.55;
}
.minimap-block.role-user {
  background: var(--color-accent);
}
.minimap-block.role-assistant {
  background: var(--color-text-muted);
}
.minimap-block.role-tool {
  background: var(--color-text-faint);
}
.minimap-thumb {
  position: absolute;
  left: 50%;
  width: 3px;
  margin-left: -1.5px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  opacity: 0;
  pointer-events: none;
  /* Only opacity is transitioned: top is rewritten by rAF every frame, and a transition would leave the pill lagging behind the real scroll position. */
  transition: opacity var(--dur-base) var(--ease-out);
}
.minimap-thumb.is-ready {
  opacity: 0.6;
}
/* Fades out after ~1s idle; reappears on hover (is-hovered wins by being last in rule order). */
.minimap.is-quiet .minimap-thumb.is-ready {
  opacity: 0;
}
.minimap.is-hovered .minimap-thumb.is-ready {
  opacity: 0.85;
}
/* Reduced motion: the thumb stays visible (JS never schedules the fade timer); only that entrance transition is dropped here. */
@media (prefers-reduced-motion: reduce) {
  .minimap-thumb {
    transition: none;
  }
}
.minimap-tooltip {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--color-text);
  white-space: nowrap;
  box-shadow: var(--shadow-md);
  pointer-events: none;
}
</style>
