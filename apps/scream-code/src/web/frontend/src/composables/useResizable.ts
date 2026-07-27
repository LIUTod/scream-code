// Drag-to-resize hook for horizontal panel width control.
// Owns the width value, clamps to [min, max], persists to localStorage.
import { onBeforeUnmount, ref, toValue, type MaybeRefOrGetter, type Ref } from 'vue';

export interface UseResizableOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: MaybeRefOrGetter<number>;
}

export function useResizable(options: UseResizableOptions) {
  const { storageKey, defaultWidth, min, max } = options;

  function clamp(value: number): number {
    if (!Number.isFinite(value)) return defaultWidth;
    return Math.min(toValue(max), Math.max(min, Math.round(value)));
  }

  function readStored(): number {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return defaultWidth;
      const n = Number(raw);
      return Number.isFinite(n) ? clamp(n) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  }

  function writeStored(value: number): void {
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // localStorage unavailable
    }
  }

  const width = ref<number>(readStored());
  const dragging = ref(false);

  function setWidth(value: number): void {
    const next = clamp(value);
    width.value = next;
    writeStored(next);
  }

  let startX = 0;
  let startWidth = 0;
  let activeEl: HTMLElement | null = null;
  let activePointerId = -1;

  function onPointerMove(event: PointerEvent): void {
    if (!dragging.value) return;
    const delta = event.clientX - startX;
    setWidth(startWidth + delta);
  }

  function endDrag(): void {
    if (!dragging.value) return;
    dragging.value = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (activeEl) {
      try { activeEl.releasePointerCapture(activePointerId); } catch { /* noop */ }
      activeEl.removeEventListener('pointermove', onPointerMove);
      activeEl.removeEventListener('pointerup', endDrag);
      activeEl.removeEventListener('pointercancel', endDrag);
    }
    activeEl = null;
    activePointerId = -1;
  }

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    dragging.value = true;
    startX = event.clientX;
    startWidth = clamp(width.value);
    activeEl = event.currentTarget as HTMLElement;
    activePointerId = event.pointerId;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    try { activeEl.setPointerCapture(event.pointerId); } catch { /* noop */ }
    activeEl.addEventListener('pointermove', onPointerMove);
    activeEl.addEventListener('pointerup', endDrag);
    activeEl.addEventListener('pointercancel', endDrag);
  }

  onBeforeUnmount(endDrag);

  return { width, dragging, clamp, setWidth, onPointerDown } as {
    width: Ref<number>;
    dragging: Ref<boolean>;
    clamp: (v: number) => number;
    setWidth: (v: number) => void;
    onPointerDown: (e: PointerEvent) => void;
  };
}
