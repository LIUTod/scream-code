<!-- G5.1 ChatMinimap.
     A thin progress strip on the right edge of the message column. It derives
     everything from the visible ChatMessage[] (seq/role/content) — there is no
     dedicated endpoint, so no new backend surface is needed.
     - Blocks are colored by role (user / assistant / tool), height proportional
       to content length.
     - Click a block -> scrollIntoView of the message row.
     - The strip highlights the messages currently inside the viewport, via
       IntersectionObserver against the host container (the chat stage).
     - Shown only at >= 960px (window.matchMedia). -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChatMessage } from '../types';

const props = defineProps<{
  messages: ChatMessage[];
  /** The scroll/viewport container that holds the message rows. */
  host: HTMLElement | null;
}>();

const hoverSeq = ref<number | null>(null);

const MIN_WIDTH_QUERY = '(min-width: 960px)';
const hasMatchMedia = typeof window.matchMedia === 'function';
const mql = hasMatchMedia ? window.matchMedia(MIN_WIDTH_QUERY) : null;
const enabled = ref(mql?.matches ?? false);

function onMql(e: MediaQueryListEvent): void {
  enabled.value = e.matches;
}
onMounted(() => mql?.addEventListener('change', onMql));
onBeforeUnmount(() => mql?.removeEventListener('change', onMql));

/* ── Segments ───────────────────────────────────────────────────────────── */
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

/* ── Viewport highlight via IntersectionObserver ────────────────────────── */
const inView = ref<Set<string>>(new Set());
let observer: IntersectionObserver | null = null;

const hasIO = typeof window !== 'undefined' && typeof IntersectionObserver === 'function';

function observe(): void {
  observer?.disconnect();
  const host = props.host;
  if (!host || !enabled.value || !hasIO) return;
  observer = new IntersectionObserver(
    (entries) => {
      const next = new Set(inView.value);
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.messageId;
        if (!id) continue;
        if (e.isIntersecting) next.add(id);
        else next.delete(id);
      }
      inView.value = next;
    },
    { root: host, threshold: 0 },
  );
  for (const msg of props.messages) {
    if (!msg.id) continue;
    const el = host.querySelector(`[data-message-id="${CSS.escape(msg.id)}"]`);
    if (el) observer.observe(el);
  }
}

// Observe AFTER the DOM patch so newly added message rows are present; a plain
// pre-flush watch would run before Vue renders the new message and the row
// would never enter the observer.
watch([() => props.messages.length, () => props.host, enabled], () => {
  nextTick(observe);
});
onMounted(() => observe());
onBeforeUnmount(() => observer?.disconnect());

function scrollToMessage(id: string): void {
  const host = props.host;
  if (!host) return;
  const el = host.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function tooltipOf(seg: Segment): string {
  const role = seg.role === 'user' ? '用户' : seg.role === 'assistant' ? '助手' : '工具';
  return `#${seg.seq} ${role}`;
}
</script>

<template>
  <div
    v-if="enabled && segments.length > 0"
    class="minimap"
    role="navigation"
    aria-label="消息地图"
  >
    <div class="minimap-track">
      <button
        v-for="seg in segments"
        :key="seg.id"
        class="minimap-block"
        :class="[`role-${seg.role}`, { 'in-view': inView.has(seg.id) }]"
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
.minimap-block {
  position: absolute;
  left: 0;
  width: 100%;
  border: none;
  border-radius: var(--radius-full);
  padding: 0;
  cursor: pointer;
  pointer-events: auto;
  opacity: 0.45;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}
.minimap-block:hover,
.minimap-block.in-view {
  opacity: 1;
}
.minimap-block.in-view {
  box-shadow: 0 0 0 1px var(--color-accent-bd);
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
