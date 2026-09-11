// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import MessageList from '../../src/web/frontend/src/components/MessageList.vue';
import { captureScrollDistance, restoreScrollTop } from '../../src/web/frontend/src/utils/scrollAnchor';

// ── Environment stand-ins (same shape as the rows/scroll suites) ──────────
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  void Promise.resolve().then(() => cb(Date.now()));
  return 0;
});
vi.stubGlobal('matchMedia', (query: string) => ({
  // Only the chat minimap's width query should answer "yes"; reduced-motion and
  // everything else stays off so scroll behavior matches the other suites.
  matches: query.includes('min-width: 960px'),
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}));

/**
 * jsdom has no IntersectionObserver. MessageList builds one in onMounted and
 * points it at the top sentinel, so the fake records who observes what and the
 * tests fire the sentinel's callback by hand ("the sentinel entered the
 * viewport"). The chat minimap builds its own observers over message rows, so
 * the callback is resolved per target element instead of globally.
 */
const ioSubscribers: Array<{
  cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
  targets: Set<Element>;
}> = [];
class FakeIntersectionObserver {
  private readonly sub: (typeof ioSubscribers)[number];
  constructor(cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
    this.sub = { cb, targets: new Set() };
    ioSubscribers.push(this.sub);
  }
  observe(el: Element): void {
    this.sub.targets.add(el);
  }
  unobserve(el: Element): void {
    this.sub.targets.delete(el);
  }
  disconnect(): void {
    this.sub.targets.clear();
  }
  takeRecords(): [] {
    return [];
  }
}
vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

function enterSentinel(): void {
  const hit = ioSubscribers.find((sub) => [...sub.targets].some((el) => el.classList.contains('load-older-row')));
  if (!hit) throw new Error('no observer is watching the top sentinel');
  const target = [...hit.targets].find((el) => el.classList.contains('load-older-row'))!;
  hit.cb([{ isIntersecting: true, target }]);
}

// Observers are created per mount, so the registry must not leak across tests —
// otherwise `enterSentinel()` would fire a dead wrapper's callback.
beforeEach(() => {
  ioSubscribers.length = 0;
});

// ── Window constants mirrored from the component (P3b) ───────────────────
const WINDOW_SIZE = 80;
const PAGE = 40;
/** Fake row height: `scrollHeight` is derived from the mounted child count. */
const ROW_PX = 100;
const CLIENT_PX = 500;
const DAY = 24 * 60 * 60 * 1000;
// 2026-09-02 09:00 local.
const T0 = new Date(2026, 8, 2, 9, 0).getTime();

type Msg = { id: string; role: 'user' | 'assistant'; content: string; ts: number | undefined; tools: [] };

// jsdom has no scrollIntoView (the minimap calls it after revealing a row) and
// no CSS.escape (its row lookup). Both exist in every target browser.
HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {};
vi.stubGlobal('CSS', { escape: (value: string) => value });

function msg(id: string, role: 'user' | 'assistant' = 'assistant', ts?: number): Msg {
  return { id, role, content: 'x', ts, tools: [] };
}

/** `n` assistant messages with no timestamps: rows === messages (no dividers). */
function build(n: number, prefix = 'm'): Msg[] {
  return Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`));
}

interface Ctx {
  wrapper: ReturnType<typeof mount>;
  el: HTMLElement;
  getTop: () => number;
  setTop: (v: number) => void;
  ids: () => string[];
  rowCount: () => number;
  scroll: () => Promise<void>;
}

/**
 * Mount the list with a fake scrollable viewport: scrollHeight is
 * `rows mounted (plus the sentinel) * ROW_PX`, so a window move has a real,
 * predictable height delta for the anchor math.
 */
function mountList(messages: Msg[], props: Record<string, unknown> = {}): Ctx {
  const wrapper = mount(MessageList, { props: { messages, sessionId: 's-win', ...props } });
  const el = wrapper.find('.message-list').element as HTMLElement;
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => el.children.length * ROW_PX,
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT_PX });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.round(v));
    },
  });
  el.scrollTo = ((opts?: ScrollToOptions | number) => {
    if (typeof opts === 'number') top = opts;
    else if (opts && typeof opts.top === 'number') top = opts;
  }) as HTMLElement['scrollTo'];
  return {
    wrapper,
    el,
    getTop: () => top,
    setTop: (v: number) => {
      top = v;
    },
    ids: () =>
      Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).map((n) => n.dataset.messageId ?? ''),
    rowCount: () => Array.from(el.children).filter((n) => !n.classList.contains('load-older-row')).length,
    scroll: async () => {
      el.dispatchEvent(new Event('scroll'));
      await wrapper.vm.$nextTick();
    },
  };
}

async function settle(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.vm.$nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

describe('scrollAnchor pure helpers', () => {
  it('keeps the same content in view when rows are inserted above (growth branch)', () => {
    // 400px from the top of 1000px of content, then 300px appear above.
    const distance = captureScrollDistance(1000, 400);
    expect(distance).toBe(600);
    expect(restoreScrollTop(1300, distance)).toBe(700); // 400 + the inserted 300
  });

  it('is a no-op when the height did not change (same branch)', () => {
    const distance = captureScrollDistance(1000, 400);
    expect(restoreScrollTop(1000, distance)).toBe(400);
  });

  it('clamps to 0 when the saved distance is out of range (content shrank)', () => {
    expect(restoreScrollTop(500, 900)).toBe(0);
    expect(restoreScrollTop(0, 0)).toBe(0);
    expect(restoreScrollTop(400, 400)).toBe(0); // bottom-aligned distance survives
  });

  it('stays consistent for a negative (overscrolled) distance', () => {
    // scrollTop past scrollHeight can happen transiently while the DOM shrinks.
    const distance = captureScrollDistance(1000, 1200);
    expect(distance).toBe(-200);
    // The formula keeps its invariant; the browser clamps the assignment itself.
    expect(restoreScrollTop(1000, distance)).toBe(1200);
    expect(restoreScrollTop(900, distance)).toBe(1100);
  });
});

describe('MessageList render window', () => {
  describe('initial window (tail cut)', () => {
    const cases: Array<{ name: string; total: number; firstIndex: number; count: number }> = [
      { name: 'short conversation renders everything', total: 20, firstIndex: 0, count: 20 },
      { name: 'exactly WINDOW_SIZE renders everything', total: 80, firstIndex: 0, count: 80 },
      { name: 'one row over cuts the head', total: 81, firstIndex: 1, count: 80 },
      { name: 'long conversation keeps the tail window', total: 300, firstIndex: 220, count: 80 },
    ];
    it.each(cases)('$name', ({ total, firstIndex, count }) => {
      const ctx = mountList(build(total));
      expect(ctx.ids()[0]).toBe(`m${firstIndex}`);
      expect(ctx.ids().at(-1)).toBe(`m${total - 1}`);
      expect(ctx.ids().length).toBe(count);
    });
  });

  it('top sentinel pages up by PAGE rows without touching the data layer', async () => {
    const ctx = mountList(build(200));
    expect(ctx.ids()[0]).toBe('m120');

    enterSentinel();
    await settle(ctx.wrapper);

    expect(ctx.ids()[0]).toBe(`m${120 - PAGE}`);
    expect(ctx.ids().length).toBe(200 - (120 - PAGE)); // window grew upward, tail intact
    expect(ctx.ids().at(-1)).toBe('m199');
    // Pure slide: no older-page request was emitted.
    expect(ctx.wrapper.emitted('load-older')).toBeUndefined();
  });

  it('sentinel slide anchors the viewport instead of jumping it', async () => {
    const ctx = mountList(build(200));
    ctx.setTop(5); // parked at the very top, sentinel in view
    const before = ctx.rowCount();

    enterSentinel();
    await settle(ctx.wrapper);

    // WINDOW grows by PAGE rows => PAGE * ROW_PX inserted ABOVE the viewport.
    expect(ctx.rowCount()).toBe(before + PAGE);
    expect(ctx.getTop()).toBe(5 + PAGE * ROW_PX);
  });

  it('sentinel only slides while rows remain above the window (no prefetch of unseen pages)', async () => {
    const ctx = mountList(build(200), { olderAvailable: true });
    enterSentinel();
    await settle(ctx.wrapper);

    // ① slide happened; ② fetch gated because windowStart (120-PAGE) > 0.
    expect(ctx.ids()[0]).toBe(`m${120 - PAGE}`);
    expect(ctx.wrapper.emitted('load-older')).toBeUndefined();
  });

  it('sentinel requests the older page once the row model is exhausted', async () => {
    // 30 messages < WINDOW_SIZE: windowStart is already 0, nothing left to slide.
    const ctx = mountList(build(30), { olderAvailable: true });
    enterSentinel();
    await settle(ctx.wrapper);

    expect(ctx.wrapper.emitted('load-older')).toHaveLength(1);
  });

  it('prepending an older page keeps windowStart and shifts scrollTop by the inserted height', async () => {
    const messages = build(200);
    const ctx = mountList(messages, { olderAvailable: true });
    ctx.setTop(1000);
    const rowsBefore = ctx.rowCount();

    // What the data layer does on a successful older-page fetch: prepend.
    await ctx.wrapper.setProps({ messages: [...build(50, 'o'), ...messages] });
    await settle(ctx.wrapper);

    // windowStart untouched (still 120) -> the DOM head slid BACK in time by the
    // 50 loaded rows while the viewport stayed put.
    expect(ctx.ids()[0]).toBe('m70');
    expect(ctx.rowCount()).toBe(rowsBefore + 50);
    expect(ctx.ids().at(-1)).toBe('m199'); // tail never trimmed
    // Anchored: 50 rows appeared above, so the viewport moved down 50 * ROW_PX.
    expect(ctx.getTop()).toBe(1000 + 50 * ROW_PX);
  });

  describe('new-message follow', () => {
    it('tail-aligned window follows the tail as messages arrive', async () => {
      const ctx = mountList(build(200));
      await ctx.wrapper.setProps({ messages: build(202) });
      await settle(ctx.wrapper);

      expect(ctx.ids().length).toBe(WINDOW_SIZE);
      expect(ctx.ids()[0]).toBe('m122');
      expect(ctx.ids().at(-1)).toBe('m201');
    });

    it('paged-up window does NOT follow: windowStart stays put', async () => {
      const ctx = mountList(build(200));
      enterSentinel();
      await settle(ctx.wrapper);
      const first = ctx.ids()[0];

      await ctx.wrapper.setProps({ messages: build(202) });
      await settle(ctx.wrapper);

      expect(ctx.ids()[0]).toBe(first); // still parked on the same history page
      expect(ctx.ids().at(-1)).toBe('m201'); // the tail is still rendered below
    });
  });

  describe('back to bottom resets the window', () => {
    it('FAB click re-arms the tail window', async () => {
      const ctx = mountList(build(200));
      enterSentinel();
      await settle(ctx.wrapper);
      expect(ctx.ids()[0]).toBe(`m${120 - PAGE}`);

      // The anchored slide leaves the viewport far from the bottom -> FAB shows.
      await ctx.scroll();
      const fab = ctx.wrapper.find('.scroll-to-bottom');
      expect(fab.exists()).toBe(true);

      await fab.trigger('click');
      await settle(ctx.wrapper);

      expect(ctx.ids().length).toBe(WINDOW_SIZE);
      expect(ctx.ids()[0]).toBe('m120');
      expect(ctx.ids().at(-1)).toBe('m199');
    });

    it('switching sessions re-arms the tail window', async () => {
      const ctx = mountList(build(200));
      enterSentinel();
      await settle(ctx.wrapper);
      expect(ctx.ids()[0]).toBe(`m${120 - PAGE}`);

      await ctx.wrapper.setProps({ sessionId: 's-other', messages: build(200, 'b') });
      await settle(ctx.wrapper);

      expect(ctx.ids().length).toBe(WINDOW_SIZE);
      expect(ctx.ids()[0]).toBe('b120');
    });
  });

  describe('minimap click reaches windowed-out rows', () => {
    /**
     * The minimap maps the FULL messages array (not the DOM), so its blocks can
     * point at rows windowing has not rendered. Clicking must slide the window
     * first. `settle` after mount: the host element prop only lands once the
     * template ref resolves, one flush after mount.
     */
    async function minimapBlocks(ctx: Ctx) {
      await settle(ctx.wrapper);
      return ctx.wrapper.findAll('.minimap-block');
    }

    it('slides the window over a message that is not rendered, then scrolls to it', async () => {
      const ctx = mountList(build(200));
      expect(ctx.ids()).not.toContain('m0');

      const blocks = await minimapBlocks(ctx);
      expect(blocks).toHaveLength(200); // segments map the messages ARRAY, not the DOM
      await blocks[0]!.trigger('click'); // -> message m0, far above the window
      await settle(ctx.wrapper);

      expect(ctx.ids()[0]).toBe('m0');
      expect(ctx.ids()).toHaveLength(200);
    });

    it('leaves the window alone when the target row is already rendered', async () => {
      const ctx = mountList(build(200));
      const blocks = await minimapBlocks(ctx);
      await blocks[150]!.trigger('click'); // m150 is inside the tail window
      await settle(ctx.wrapper);

      expect(ctx.ids()[0]).toBe('m120');
      expect(ctx.ids()).toHaveLength(WINDOW_SIZE);
    });
  });

  describe('window-edge divider correctness', () => {
    /**
     * Both cases put a divider EXACTLY at the window head: 100 rows before it,
     * 79 after it (179 messages, 180 rows) -> windowStart === 100 === tailStart.
     */
    const cases = [
      {
        name: 'turn hairline at the window head still renders',
        messages: (): Msg[] => [
          ...build(100),
          msg('edge', 'user', T0),
          ...Array.from({ length: 78 }, (_, i) => msg(`after${i}`, 'assistant', T0)),
        ],
        firstClass: 'turn-divider',
      },
      {
        name: 'day pill at the window head still renders (with its text)',
        messages: (): Msg[] => [
          ...Array.from({ length: 100 }, (_, i) => msg(`m${i}`, 'assistant', T0)),
          msg('edge', 'user', T0 + DAY),
          ...Array.from({ length: 78 }, (_, i) => msg(`after${i}`, 'assistant', T0 + DAY)),
        ],
        firstClass: 'day-divider',
      },
    ];

    it.each(cases)('$name', ({ messages, firstClass }) => {
      const ctx = mountList(messages());
      const children = Array.from(ctx.el.children).filter((n) => !n.classList.contains('load-older-row'));
      // Row model is built from the FULL messages array, so the cut keeps the
      // divider that belongs to the first rendered message.
      expect(children[0]!.className).toContain(firstClass);
      expect((children[1] as HTMLElement).dataset.messageId).toBe('edge');
      expect(ctx.ids().length).toBe(79);
      expect(ctx.ids()[0]).toBe('edge');
    });
  });
});
