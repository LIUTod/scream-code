import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { clampPanelWidth } from '../utils/panelLayout';
import { readStoredJSON, writeStoredJSON } from '../utils/storage';

/**
 * Pointer/keyboard resizing for a shell panel (sidebar or right file panel).
 * Both handles used to carry a copy of the same drag logic; the only real
 * differences are which edge they track and how their clamp ceiling is
 * derived, so those are parameters here.
 *
 * - `side: 'left'`  — width follows `clientX` directly (sidebar).
 * - `side: 'right'` — the handle sits on the panel's left edge, so width is
 *   `window.innerWidth - clientX` and the arrow keys invert.
 */
export interface PanelResizeOptions {
  /** localStorage key the width persists under. */
  storageKey: string;
  /** Absolute floor for the width. */
  minWidth: number;
  /** Static ceiling, or a reactive getter when the ceiling interlocks with
   *  other chrome (viewport / neighbouring panel). */
  maxWidth: number | (() => number);
  /** Restored width when nothing valid is stored; may depend on the viewport. */
  defaultWidth: number | (() => number);
  /** Which screen edge the panel is anchored to. */
  side: 'left' | 'right';
  /** Extra gate checked on pointerdown (e.g. the collapsed sidebar refuses drags). */
  canDrag?: () => boolean;
  /** Accept a stored number on top of the built-in finite/min checks. */
  acceptStoredWidth?: (width: number) => boolean;
}

export interface PanelResize {
  /** Raw desired width (persisted value). */
  width: Ref<number>;
  /** Width after clamping — what layout should consume. */
  effectiveWidth: ComputedRef<number>;
  resizing: Ref<boolean>;
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onKeydown: (e: KeyboardEvent) => void;
  /** Double-click: restore the default width. */
  reset: () => void;
  /** Stop an in-flight drag and persist (used when the handle unmounts
   *  mid-drag, e.g. crossing the split breakpoint). */
  release: () => void;
}

export function usePanelResize(options: PanelResizeOptions): PanelResize {
  const { storageKey, minWidth, side } = options;
  const resolve = (v: number | (() => number)): number => (typeof v === 'function' ? v() : v);
  const maxOf = (): number => resolve(options.maxWidth);

  function readStoredWidth(): number {
    const stored = readStoredJSON<number>(storageKey);
    if (
      typeof stored === 'number' &&
      Number.isFinite(stored) &&
      stored >= minWidth &&
      (options.acceptStoredWidth?.(stored) ?? true)
    ) {
      return Math.round(stored);
    }
    return resolve(options.defaultWidth);
  }

  const width = ref(readStoredWidth());
  const resizing = ref(false);
  let pointerId: number | null = null;

  function persist(): void {
    writeStoredJSON(storageKey, width.value);
  }

  /** Pointer x-position → desired width, per anchor side. */
  function widthFromClientX(clientX: number): number {
    return side === 'left' ? clientX : window.innerWidth - clientX;
  }

  function onPointerDown(e: PointerEvent): void {
    if (options.canDrag && !options.canDrag()) return;
    e.preventDefault();
    resizing.value = true;
    pointerId = e.pointerId;
    // Capture keeps the drag alive when the pointer leaves the 12px strip.
    // Synthetic events (tests/automation) carry an inactive pointerId — the
    // move/up handlers still work, so a failed capture must not abort the drag.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!resizing.value || e.pointerId !== pointerId) return;
    width.value = clampPanelWidth(widthFromClientX(e.clientX), minWidth, maxOf());
  }

  function onPointerUp(e: PointerEvent): void {
    if (!resizing.value || e.pointerId !== pointerId) return;
    release();
  }

  function release(): void {
    resizing.value = false;
    pointerId = null;
    persist();
  }

  function reset(): void {
    width.value = clampPanelWidth(resolve(options.defaultWidth), minWidth, maxOf());
    persist();
  }

  function onKeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? 32 : 12;
    const grow = side === 'left' ? 1 : -1;
    // Arrows follow visual intuition: on a left-anchored panel ArrowRight
    // widens it; on a right-anchored panel ArrowLeft does (it is pulled left).
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      width.value = clampPanelWidth(width.value - grow * step, minWidth, maxOf());
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      width.value = clampPanelWidth(width.value + grow * step, minWidth, maxOf());
    } else if (e.key === 'Home') {
      e.preventDefault();
      width.value = minWidth;
    } else if (e.key === 'End') {
      e.preventDefault();
      width.value = clampPanelWidth(maxOf(), minWidth, maxOf());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      reset();
    } else {
      return;
    }
    persist();
  }

  const effectiveWidth = computed(() => clampPanelWidth(width.value, minWidth, maxOf()));

  return {
    width,
    effectiveWidth,
    resizing,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeydown,
    reset,
    release,
  };
}
