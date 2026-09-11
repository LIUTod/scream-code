// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  usePanelResize,
  type PanelResizeOptions,
} from '../../src/web/frontend/src/composables/usePanelResize';

const MIN = 180;
const MAX = 480;
const KEY = 'test-panel-width';

function makeOptions(overrides: Partial<PanelResizeOptions> = {}): PanelResizeOptions {
  return {
    storageKey: KEY,
    minWidth: MIN,
    maxWidth: MAX,
    defaultWidth: 288,
    side: 'left',
    ...overrides,
  };
}

/** jsdom lacks PointerEvent; the handlers only read fields, so plain objects work. */
function pointerEvent(pointerId: number, clientX: number) {
  return {
    pointerId,
    clientX,
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: vi.fn(),
    },
  } as unknown as PointerEvent;
}

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe('usePanelResize', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
  });

  it('restores a valid stored width', () => {
    localStorage.setItem(KEY, '333');
    const r = usePanelResize(makeOptions());
    expect(r.width.value).toBe(333);
  });

  it('falls back to the default on a missing key', () => {
    const r = usePanelResize(makeOptions());
    expect(r.width.value).toBe(288);
  });

  it('falls back to the default on corrupt or below-min stored values', () => {
    localStorage.setItem(KEY, '{oops');
    expect(usePanelResize(makeOptions()).width.value).toBe(288);
    localStorage.setItem(KEY, '100'); // below min
    expect(usePanelResize(makeOptions()).width.value).toBe(288);
  });

  it('has no built-in upper bound on load; hosts opt in via acceptStoredWidth', () => {
    localStorage.setItem(KEY, '999');
    expect(usePanelResize(makeOptions()).width.value).toBe(999);
    expect(usePanelResize(makeOptions({ acceptStoredWidth: (w) => w <= MAX })).width.value).toBe(288);
  });

  it('acceptStoredWidth gates restoration beyond the built-in checks', () => {
    localStorage.setItem(KEY, '460');
    // Sidebar semantics: anything up to the static max is fine.
    expect(usePanelResize(makeOptions({ acceptStoredWidth: () => true })).width.value).toBe(460);
    // Right-panel semantics: no upper bound check on load.
    expect(usePanelResize(makeOptions({ acceptStoredWidth: (w) => w <= 400 })).width.value).toBe(288);
  });

  it('drags a left-anchored panel by clientX and clamps to the band', () => {
    const r = usePanelResize(makeOptions());
    r.onPointerDown(pointerEvent(1, 0));
    expect(r.resizing.value).toBe(true);
    r.onPointerMove(pointerEvent(1, 350));
    expect(r.width.value).toBe(350);
    r.onPointerMove(pointerEvent(1, 50)); // below min
    expect(r.width.value).toBe(MIN);
    r.onPointerMove(pointerEvent(1, 900)); // above max
    expect(r.width.value).toBe(MAX);
  });

  it('drags a right-anchored panel from the opposite edge and inverts arrows', () => {
    const r = usePanelResize(makeOptions({ side: 'right', minWidth: 300, maxWidth: 1200 }));
    r.onPointerDown(pointerEvent(7, 0));
    // Panel edge at clientX: width = innerWidth - clientX.
    r.onPointerMove(pointerEvent(7, 1440 - 560));
    expect(r.width.value).toBe(560);
    r.onKeydown(keyEvent('ArrowLeft')); // pulls the panel wider
    expect(r.width.value).toBe(572);
    r.onKeydown(keyEvent('ArrowRight'));
    r.onKeydown(keyEvent('ArrowRight'));
    expect(r.width.value).toBe(548);
  });

  it('ignores moves from a foreign pointer id', () => {
    const r = usePanelResize(makeOptions());
    r.onPointerDown(pointerEvent(1, 0));
    r.onPointerMove(pointerEvent(2, 400));
    expect(r.width.value).toBe(288);
  });

  it('persists the width on pointerup', () => {
    const r = usePanelResize(makeOptions());
    r.onPointerDown(pointerEvent(1, 0));
    r.onPointerMove(pointerEvent(1, 333));
    r.onPointerUp(pointerEvent(1, 333));
    expect(r.resizing.value).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toBe(333);
  });

  it('release() stops a drag without a pointerup (breakpoint flip)', () => {
    const r = usePanelResize(makeOptions());
    r.onPointerDown(pointerEvent(1, 0));
    r.onPointerMove(pointerEvent(1, 310));
    r.release();
    expect(r.resizing.value).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toBe(310);
  });

  it('reset() restores the default and persists it', () => {
    localStorage.setItem(KEY, '400');
    const r = usePanelResize(makeOptions());
    r.reset();
    expect(r.width.value).toBe(288);
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toBe(288);
  });

  it('keyboard resize steps by 12 (32 with shift), honors Home/End, Enter resets', () => {
    const r = usePanelResize(makeOptions());
    r.onKeydown(keyEvent('ArrowRight'));
    expect(r.width.value).toBe(300);
    r.onKeydown(keyEvent('ArrowRight', true)); // shift → 32
    expect(r.width.value).toBe(332);
    r.onKeydown(keyEvent('ArrowLeft', true));
    expect(r.width.value).toBe(300);
    r.onKeydown(keyEvent('End'));
    expect(r.width.value).toBe(MAX);
    r.onKeydown(keyEvent('Home'));
    expect(r.width.value).toBe(MIN);
    r.onKeydown(keyEvent('Enter'));
    expect(r.width.value).toBe(288);
  });

  it('unhandled keys neither move nor persist', () => {
    const r = usePanelResize(makeOptions());
    r.onKeydown(keyEvent('a'));
    expect(r.width.value).toBe(288);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('canDrag blocks the drag start', () => {
    let allowed = false;
    const r = usePanelResize(makeOptions({ canDrag: () => allowed }));
    r.onPointerDown(pointerEvent(1, 0));
    expect(r.resizing.value).toBe(false);
    allowed = true;
    r.onPointerDown(pointerEvent(1, 0));
    expect(r.resizing.value).toBe(true);
  });

  it('effectiveWidth clamps a stale width into a shrunken interlock ceiling', () => {
    const state = { max: 480 };
    const r = usePanelResize(makeOptions({ maxWidth: () => state.max }));
    r.onPointerDown(pointerEvent(1, 0));
    r.onPointerMove(pointerEvent(1, 460));
    r.onPointerUp(pointerEvent(1, 460));
    state.max = 300; // e.g. the right panel opened
    expect(r.width.value).toBe(460); // raw desire unchanged
    expect(r.effectiveWidth.value).toBe(300); // layout sees the clamp
  });

  it('uses a dynamic default when none is stored', () => {
    const r = usePanelResize(makeOptions({ defaultWidth: () => 400 }));
    expect(r.width.value).toBe(400);
  });
});
