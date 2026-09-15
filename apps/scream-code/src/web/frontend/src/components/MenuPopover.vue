<script lang="ts">
/**
 * Global mutual-exclusion registry: at most one popover menu is open at a time.
 *
 * This must live at module scope. It used to be a `let closeCurrentMenu` inside
 * <script setup>, which compiles to one copy per component instance — a menu
 * opening menu B still read its own null and could not close menu A, and opening
 * a menu with the keyboard (no pointerdown fallback) left two panels on screen
 * at once. Each consumer's own "only one open" rule can only cover its own menus
 * (inside the composer a single openMenu value does that); across components
 * (composer chip ↔ header "more" ↔ sidebar row "more") only this module-level
 * registry can close the loop.
 */
let closeCurrentMenu: (() => void) | null = null;

/** Closes any menu opened elsewhere before a new one opens. */
export function claimMenuSlot(close: () => void): void {
  closeCurrentMenu?.();
  closeCurrentMenu = close;
}

/** Deregisters: only clears when the current holder is still this menu, so a later claimant's slot is not wiped. */
export function releaseMenuSlot(close: () => void): void {
  if (closeCurrentMenu === close) closeCurrentMenu = null;
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import type { MenuGroup } from '../utils/menus';
import { computePopoverStyle } from '../utils/popoverPosition';
import SvgIcon from './ui/SvgIcon.vue';

/**
 * Popover menu shell (L2).
 *
 * Reuses the existing popover styling language (same as ModelPicker /
 * HistoryMenu: surface-raised + shadow-elevation-prominent hairline stroke +
 * rise-in entrance) and collapses "close on outside click, close on Esc, render
 * items" into one shell shared by the composer chip, the header "more" menu and
 * the sidebar row "more" menu — callers only feed items and handle select, while
 * open state stays with the parent (v-model:open), so several menus on the same
 * row are mutually exclusive by construction.
 *
 * The popover is fixed + Teleported to body by default: the sidebar list and the
 * composer both sit in scroll containers where an absolutely positioned panel
 * gets clipped by overflow. Fixed positioning anchors on the trigger shell's
 * rect and closes on scroll/zoom, so the menu never detaches from its entry
 * point. The trigger goes through the default slot and is wrapped in the same
 * shell, so clicking your own trigger is not treated as an outside click.
 */
const props = withDefaults(
  defineProps<{
    /** Accessible name (aria-label of role=menu). */
    label: string;
    groups: MenuGroup[];
    open: boolean;
    /** Popover alignment edge (relative to the trigger shell). */
    align?: 'right' | 'left';
    /** Whether the popover lands above or below the anchor. */
    placement?: 'top' | 'bottom';
    /** Max width (300px overflows the viewport in a narrow sidebar). */
    maxWidth?: number;
    heading?: string;
  }>(),
  { align: 'right', placement: 'top', maxWidth: 300, heading: undefined },
);

const emit = defineEmits<{
  (e: 'select', key: string): void;
  (e: 'update:open', value: boolean): void;
}>();

/**
 * Global mutual exclusion: at most one popover menu open at a time.
 * Each consumer's own "only one open" rule can only cover its own menus (inside
 * the composer a single openMenu value does that); across components (composer
 * chip ↔ header "more" ↔ sidebar row "more") the module-scope registry closes
 * the loop (see claimMenuSlot / releaseMenuSlot at the top of this file),
 * otherwise two menus end up on screen at once.
 */

const rootRef = ref<HTMLElement | null>(null);
const panelStyle = ref<CSSProperties>({});

function close() {
  if (props.open) emit('update:open', false);
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      // Cross-component exclusion: close a menu opened elsewhere first.
      claimMenuSlot(close);
      measure();
      // A scroll in an ancestor container (sidebar list, composer column) does
      // not bubble, so it has to be caught on document in the capture phase.
      document.addEventListener('scroll', onViewportChange, true);
      window.addEventListener('resize', onViewportChange);
    } else {
      releaseMenuSlot(close);
      document.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    }
  },
);

/** Computes fixed positioning from the trigger shell's rect, clamped back inside the viewport when it would overflow (shared operator with ModelPicker). */
function measure(): void {
  const el = rootRef.value;
  if (!el) return;
  panelStyle.value = computePopoverStyle(el.getBoundingClientRect(), {
    placement: props.placement,
    align: props.align,
    maxWidth: props.maxWidth,
  });
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  const root = rootRef.value;
  // Neither the trigger (root subtree) nor the popover body counts as an outside
  // click. The popover is Teleported onto body, so it is not inside the root
  // subtree — testing root alone let a real pointerdown close the menu before the
  // click landed: the menu appeared, but picking an item never did anything
  // (reproduced on a real machine). The equivalent check in ModelPicker is bound
  // to the panel ref, so here ownership has to be decided by a container marker.
  if (root?.contains(target)) return;
  if (target instanceof Element && target.closest('[data-menu-popover]')) return;
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) {
    // While the menu is open, Esc only closes the menu — it must not bubble into
    // global actions such as "stop the turn".
    event.stopPropagation();
    close();
  }
}

/** After a scroll or zoom the anchor has moved; closing beats leaving the menu floating at a stale position. */
function onViewportChange(): void {
  close();
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeydown, true);
  if (props.open) {
    measure();
    document.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }
});
onBeforeUnmount(() => {
  releaseMenuSlot(close);
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});
</script>

<template>
  <span ref="rootRef" class="menu-root">
    <slot />
    <Teleport to="body">
      <div
        v-if="open"
        class="menu-popover"
        :class="[`is-align-${align}`, `is-placement-${placement}`]"
        :style="panelStyle"
        role="menu"
        :aria-label="label"
        data-menu-popover
      >
        <p v-if="heading" class="menu-heading">{{ heading }}</p>
        <template v-for="(group, gi) in groups" :key="`g${gi}`">
          <p v-if="group.title" class="menu-group-title">{{ group.title }}</p>
          <button
            v-for="entry in group.entries"
            :key="entry.key"
            class="menu-entry"
            :class="{ 'is-active': entry.checked, 'is-danger': entry.tone === 'danger' }"
            role="menuitem"
            type="button"
            :disabled="entry.disabled"
            :title="entry.title ?? entry.label"
            :aria-current="entry.checked ? 'true' : undefined"
            @click="emit('select', entry.key)"
          >
            <SvgIcon v-if="entry.icon" :name="entry.icon" :size="14" />
            <span class="entry-label">{{ entry.label }}</span>
            <SvgIcon v-if="entry.checked" name="check" :size="14" class="entry-check" />
          </button>
        </template>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
/* The shell takes no part in layout (inline container, positioning anchor for the popover). */
.menu-root {
  display: inline-flex;
  min-width: 0;
}

.menu-popover {
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 168px;
  max-height: min(60vh, 340px);
  padding: var(--space-1);
  background: var(--color-surface-raised);
  border: 0;
  border-radius: var(--radius-lg);
  /* Elevated surface: hairline stroke, no layout border. */
  box-shadow: var(--shadow-elevation-prominent);
  --shadow-stroke-color: var(--color-text-faint);
  overflow-y: auto;
  animation: rise-in var(--dur-slower) var(--ease-spring);
}

.menu-heading {
  padding: var(--space-1) var(--space-2) var(--space-2);
  margin-bottom: 2px;
  border-bottom: 1px solid var(--color-line);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.menu-group-title {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.menu-empty {
  padding: var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--font-size-xs);
}

.menu-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.menu-entry:hover:not(:disabled) {
  background: var(--color-hover);
}
.menu-entry:disabled {
  color: var(--color-text-faint);
  cursor: default;
}
.menu-entry.is-active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.menu-entry.is-danger {
  color: var(--color-danger);
}
.menu-entry.is-danger:hover:not(:disabled) {
  background: var(--color-danger-soft);
}
.entry-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-check {
  flex-shrink: 0;
  color: var(--color-accent);
}

@media (prefers-reduced-motion: reduce) {
  .menu-popover {
    animation: none;
  }
}
</style>
