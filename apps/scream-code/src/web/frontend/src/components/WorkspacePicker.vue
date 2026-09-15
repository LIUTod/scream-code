<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';

import { fetchDirEntries, type ServerFileEntry } from '../utils/fileDirCache';
import { splitPath } from '../utils/pathLabel';
import { computePopoverStyle } from '../utils/popoverPosition';
import { workDirBasename } from '../composables/useWorkspacePreference';
import SvgIcon from './ui/SvgIcon.vue';

/**
 * Workspace picker popover (opened from the workspace chip on the home screen).
 *
 * Three entry points, ordered by cost from cheapest to most specific: a path
 * input (type anything; the server only validates when the session is created) →
 * recent workspaces (derived from the session list) → subdirectory shortcuts
 * (reusing the /files/list cache; FileGate only allows directories of existing
 * sessions, and the whole section is hidden when it cannot list anything rather
 * than explaining a wall of 403s).
 * The client only pre-checks "is an absolute path" — existence and writability
 * are the server's call, and this does not grow a second set of rules to fight
 * with it.
 *
 * The popover lands like ModelPicker's: Teleport to body + position:fixed,
 * positioned from the trigger chip's viewport rect. It used to be an absolute
 * popover inside .composer-chips (overflow-x:auto) and was clipped away
 * entirely, so a real click on the workspace chip never opened it (reproduced on
 * a real machine) — the same trap ModelPicker was fixed for.
 */
const props = withDefaults(
  defineProps<{
    /** Path currently shown (selected, or the server default). */
    current?: string;
    /** Server default workspace, used as the input placeholder. */
    defaultDir?: string;
    /** Recently used workspaces (deduplicated session workDir list). */
    recentWorkDirs?: string[];
  }>(),
  { current: '', defaultDir: '', recentWorkDirs: () => [] },
);

const emit = defineEmits<{
  (e: 'select', dir: string): void;
  (e: 'close'): void;
}>();

const pathValue = ref(props.current || props.defaultDir);
const inputRef = ref<HTMLInputElement | null>(null);
/** In-place anchor: the component's DOM slot in the chip row (display:contents, zero layout footprint). */
const anchorRef = ref<HTMLElement | null>(null);
/** The popover body Teleported to body. */
const rootRef = ref<HTMLElement | null>(null);
const panelStyle = ref<CSSProperties>({});

/** Only pre-checks "is an absolute path"; an empty string cannot be submitted. */
const looksAbsolute = computed(() => pathValue.value.trim().startsWith('/'));
const canSubmit = computed(() => looksAbsolute.value && pathValue.value.trim().length > 0);

function submit() {
  if (!canSubmit.value) return;
  emit('select', pathValue.value.trim());
}

/* ── Subdirectory browsing: debounced fetch after the path changes (fileDirCache already dedupes) ── */
const subDirs = ref<ServerFileEntry[]>([]);
let browseTimer: ReturnType<typeof setTimeout> | undefined;

watch(pathValue, (value) => {
  clearTimeout(browseTimer);
  const abs = value.trim();
  if (!abs.startsWith('/')) {
    subDirs.value = [];
    return;
  }
  browseTimer = setTimeout(async () => {
    const entries = await fetchDirEntries(abs);
    // Race guard: a slow response arrives after the input changed — drop it.
    if (pathValue.value.trim() !== abs) return;
    subDirs.value = (entries ?? []).filter((e) => e.type === 'dir').slice(0, 8);
  }, 250);
});

function enterDir(entry: ServerFileEntry) {
  pathValue.value = entry.path;
  inputRef.value?.focus();
}

/* ── Positioning: place the fixed popover from the trigger chip's viewport rect ── */
function measure(): void {
  const anchor = anchorRef.value;
  if (!anchor) return;
  // The real anchor is the chip button: both live under .chip-slot, so it is
  // recovered with closest; when the component is mounted on its own (detached
  // from .chip-slot) fall back to the global .workspace-select.
  const chip =
    anchor.closest('.chip-slot')?.querySelector('.workspace-select') ??
    document.querySelector('.workspace-select');
  const rect = (chip ?? anchor).getBoundingClientRect();
  const gap = 6;
  const edge = 8;
  // On a narrow viewport the 360px fixed width must not push past the screen edge (the shared operator clamps horizontally by maxWidth).
  const style = computePopoverStyle(rect, {
    placement: 'top',
    align: 'left',
    maxWidth: Math.min(360, window.innerWidth - edge * 2),
    gap,
    edge,
  });
  // Opens upward: the available height is the room between the anchor's top edge and the viewport top; keeps the old 60vh ceiling.
  style.maxHeight = `min(60vh, ${Math.max(240, rect.top - gap - edge)}px)`;
  panelStyle.value = style;
}

/* ── Close on outside click / Esc: the chip itself is not an outside click (same guard as ModelPicker) ── */
function onDocMousedown(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (target instanceof Element && target.closest('.workspace-select')) return;
  // The popover body is Teleported onto body, so it is not in the component's root subtree — ownership is decided by rootRef alone.
  if (rootRef.value && !rootRef.value.contains(target)) emit('close');
}

/** An ancestor scroll container's scroll does not bubble, so it can only be caught on document; scrolls inside the popover are excluded (same as ModelPicker). */
function onViewportChange(event: Event): void {
  const t = event.target;
  if (t instanceof Node && rootRef.value?.contains(t)) return;
  emit('close');
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown, true);
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  void nextTick(() => {
    measure();
    inputRef.value?.focus();
    inputRef.value?.select();
  });
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown, true);
  document.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
  clearTimeout(browseTimer);
});
</script>

<template>
  <!-- In-place anchor: keeps the popover's DOM slot in the chip row (existing query contract); the real panel lives in the Teleport. -->
  <span ref="anchorRef" class="workspace-picker workspace-picker--anchor">
    <Teleport to="body">
      <div
        ref="rootRef"
        class="workspace-picker"
        :style="panelStyle"
        role="dialog"
        aria-label="选择工作区"
        @keydown.esc.stop="emit('close')"
      >
        <p class="picker-title">工作区（下一次新建）</p>
        <div class="picker-input-row">
          <input
            ref="inputRef"
            v-model="pathValue"
            class="picker-path-input"
            data-testid="workspace-path-input"
            :placeholder="defaultDir || '输入绝对路径，如 /Users/you/project'"
            spellcheck="false"
            @keydown.enter.prevent="submit"
          />
          <button
            class="picker-apply"
            data-testid="workspace-apply"
            :disabled="!canSubmit"
            :title="canSubmit ? '使用该目录新建会话' : '工作区必须是绝对路径'"
            @click="submit"
          >
            选择
          </button>
        </div>
        <p v-if="pathValue.trim() && !looksAbsolute" class="picker-warn">需要绝对路径（以 / 开头）</p>

        <template v-if="recentWorkDirs.length">
          <p class="picker-section">最近使用</p>
          <div class="picker-rows">
            <button
              v-for="dir in recentWorkDirs"
              :key="dir"
              class="picker-row"
              :title="dir"
              @click="emit('select', dir)"
            >
              <SvgIcon name="folder" :size="14" />
              <span class="row-base">{{ workDirBasename(dir) }}</span>
              <!-- The directory prefix goes through splitPath's whole-segment trim: the rtl ellipsis trick scrambles path order -->
              <span class="row-path">{{ splitPath(dir).dir }}</span>
            </button>
          </div>
        </template>

        <template v-if="subDirs.length">
          <p class="picker-section">子目录</p>
          <div class="picker-rows">
            <button
              v-for="entry in subDirs"
              :key="entry.path"
              class="picker-row"
              :title="entry.path"
              @click="enterDir(entry)"
            >
              <SvgIcon name="folder" :size="14" />
              <span class="row-base">{{ entry.name }}</span>
            </button>
          </div>
        </template>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.workspace-picker {
  /* The popover body is fixed onto body (the former absolute bottom:100%/left:0
     was clipped away by .composer-chips' overflow-x:auto); top/bottom, left,
     maxWidth and maxHeight are supplied as inline styles by the shared
     positioning operator. */
  position: fixed;
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 360px;
  max-width: calc(100vw - var(--space-8));
  max-height: 60vh;
  padding: var(--space-2);
  background: var(--color-surface-raised);
  border-radius: var(--radius-lg);
  /* Same raised surface as ModelPicker: hairline stroke + dark scrollbar. */
  box-shadow: var(--shadow-elevation-prominent);
  --shadow-stroke-color: var(--color-text-faint);
  --scrollbar-thumb: var(--color-text-faint);
  --scrollbar-thumb-hover: var(--color-text-muted);
  overflow: hidden auto;
  animation: rise-in var(--dur-slower) var(--ease-spring);
}
/* The in-place anchor shares the .workspace-picker class name to keep the
   existing query contract, but it must have zero box: display:contents takes no
   part in layout and renders none of the visual declarations above. Declared
   after the base rule so it overrides display:flex at equal specificity. */
.workspace-picker--anchor {
  display: contents;
}
.picker-title {
  margin: 0;
  padding: var(--space-1) var(--space-1) 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.picker-input-row {
  display: flex;
  gap: var(--space-1);
}
.picker-path-input {
  flex: 1;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
}
.picker-path-input:focus {
  outline: none;
  border-color: var(--color-accent-bd);
  box-shadow: var(--glow-focus);
}
.picker-path-input::placeholder {
  color: var(--color-text-faint);
  font-family: inherit;
}
.picker-apply {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: none;
}
.picker-apply:hover:not(:disabled) {
  border-color: var(--color-accent-bd);
  background: var(--color-hover);
}
.picker-apply:disabled {
  opacity: 0.5;
  cursor: default;
}
.picker-warn {
  margin: 0;
  padding: 0 var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}
.picker-section {
  margin: var(--space-2) 0 0;
  padding: 0 var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-faint);
}
.picker-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.picker-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: none;
}
.picker-row:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.row-base {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
}
@media (prefers-reduced-motion: reduce) {
  .workspace-picker {
    animation: none;
  }
}
</style>
