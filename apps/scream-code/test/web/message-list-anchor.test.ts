// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import MessageList from '../../src/web/frontend/src/components/MessageList.vue';

// ── Environment stand-ins (same shape as message-window.test.ts) ──────────
// rAF is a manual queue rather than a microtask stand-in: restore, save and
// ResizeObserver coalescing all go through rAF, so an explicit flush is what lets
// a test insert its offsetTop mock between "DOM ready" and "effects run".
const rafQueue: FrameRequestCallback[] = [];
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
});
vi.stubGlobal('cancelAnimationFrame', () => {});
function flushRaf(times = 1): void {
  for (let i = 0; i < times; i++) {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb(Date.now());
  }
}

vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query.includes('min-width: 960px'),
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}));
// jsdom has no Element.scrollTo/scrollIntoView (see message-window.test.ts).
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};
vi.stubGlobal('CSS', { escape: (value: string) => value });

/**
 * jsdom has no IntersectionObserver. MessageList builds one in onMounted and
 * points it at the top sentinel; the chat minimap builds its own over message
 * rows. The fake records who observes what (same pattern as message-window).
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

/**
 * jsdom has no ResizeObserver either. MessageList observes **row elements** (the
 * scroll container itself is a fixed-height box, so content growth never changes
 * its box and observing it would never fire), so this stand-in records "who is
 * observed" the way the real thing does, and callbacks are only dispatched to
 * genuinely observed targets.
 */
const roInstances: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
class FakeResizeObserver {
  private readonly sub: (typeof roInstances)[number];
  constructor(cb: ResizeObserverCallback) {
    this.sub = { cb, targets: new Set() };
    roInstances.push(this.sub);
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
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);

/**
 * The current target set of MessageList's height observer (it re-aligns
 * incrementally after every DOM patch). The chat minimap runs its own RO over the
 * scroll container (a legitimate use there: viewport/column changes really do
 * change that box), so only the observer watching message rows is collected here,
 * keeping the minimap's container target out of the count.
 */
function listResizeTargets(): Element[] {
  return roInstances
    .filter((sub) => Array.from(sub.targets).some((t) => (t as HTMLElement).dataset?.messageId !== undefined))
    .flatMap((sub) => Array.from(sub.targets));
}

/**
 * Dispatch size callbacks along the real path: one callback = one **observed
 * element's** box changing. Without a target, every target gets one callback
 * (equivalent to all rows growing at once).
 */
function fireResize(target?: Element): void {
  for (const sub of roInstances) {
    const hits = target ? Array.from(sub.targets).filter((t) => t === target) : Array.from(sub.targets);
    for (const hit of hits) sub.cb([{ target: hit } as ResizeObserverEntry], sub as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  ioSubscribers.length = 0;
  roInstances.length = 0;
  localStorage.clear();
});

// ── Layout model ───────────────────────────────────────────────────────────
const ROW_PX = 100;
const CLIENT_PX = 300;
const SESSION = 's-anchor';

/** seq is the stable identifier of the server journal; id is a random value the frontend regenerates on every persist/reconnect. */
type Msg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number | undefined;
  tools: [];
  seq?: number;
};

function msg(id: string, seq?: number): Msg {
  return { id, role: 'assistant', content: 'x', ts: undefined, tools: [], ...(seq === undefined ? {} : { seq }) };
}

/** `n` assistant messages with no timestamps: rows === messages (no dividers). */
function build(n: number, prefix = 'm'): Msg[] {
  return Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`, i));
}

interface Ctx {
  wrapper: ReturnType<typeof mount>;
  el: HTMLElement;
  getTop: () => number;
  setTop: (v: number) => void;
  setScrollHeight: (v: number) => void;
  /** scrollHeight := mounted children (message rows + sentinel) * ROW_PX. */
  syncHeight: () => void;
  scrollToSpy: ReturnType<typeof vi.fn>;
  ids: () => string[];
  scroll: () => Promise<void>;
}

/**
 * Mount the list with a fake scrollable viewport (same mock pattern as
 * message-window.test.ts). Mounts EMPTY so the first setProps takes the
 * "initial load" restore path, exactly like the other suites.
 */
function mountList(props: Record<string, unknown> = {}): Ctx {
  const wrapper = mount(MessageList, { props: { messages: [], sessionId: SESSION, ...props } });
  const el = wrapper.find('.message-list').element as HTMLElement;
  let top = 0;
  let height = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT_PX });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.round(v));
    },
  });
  const scrollToSpy = vi.fn((opts?: ScrollToOptions | number) => {
    if (typeof opts === 'number') top = opts;
    else if (opts && typeof opts.top === 'number') top = opts.top;
  });
  el.scrollTo = scrollToSpy as unknown as HTMLElement['scrollTo'];
  const ctx: Ctx = {
    wrapper,
    el,
    getTop: () => top,
    setTop: (v) => {
      top = v;
    },
    setScrollHeight: (v) => {
      height = v;
    },
    syncHeight: () => {
      height = el.children.length * ROW_PX;
    },
    scrollToSpy,
    ids: () =>
      Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).map((n) => n.dataset.messageId ?? ''),
    scroll: async () => {
      el.dispatchEvent(new Event('scroll'));
      await wrapper.vm.$nextTick();
    },
  };
  return ctx;
}

/** Deliver the session's initial messages (takes the restore path, not unread). */
async function initialLoad(ctx: Ctx, messages: Msg[]): Promise<void> {
  await ctx.wrapper.setProps({ messages });
  await ctx.wrapper.vm.$nextTick();
}

async function settle(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.vm.$nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

/**
 * Run the whole "restore + bottom fallback" flow to completion: two rAF layers,
 * the nextTick of the async restore, and one more rAF inside scrollToBottom. Two
 * flush rounds leave room for a settle (microtask) in between.
 */
async function settleRestore(ctx: Ctx): Promise<void> {
  flushRaf(3);
  await settle(ctx.wrapper);
  flushRaf(3);
  await settle(ctx.wrapper);
}

/**
 * Mock every message row's offsetTop at the prototype level: rows revealed by
 * a window slide mount AFTER the test's mock point, so per-element mocks would
 * miss them. jsdom has no layout — its offsetTop is a configurable getter
 * returning 0 — so overriding it is safe and hits rows mounted later too.
 * Non-message elements (and rows with no mapping) keep offsetTop 0.
 */
let offsetMapOf: (messageId: string) => number = () => 0;
beforeEach(() => {
  offsetMapOf = () => 0;
});
Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
  configurable: true,
  get(this: HTMLElement) {
    const id = this.dataset?.messageId;
    return id ? offsetMapOf(id) : 0;
  },
});

describe('follow threshold (FOLLOW_THRESHOLD)', () => {
  it('follows new messages when within 24px of the bottom', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10)); // 1000px content
    ctx.syncHeight();
    ctx.setTop(1000 - CLIENT_PX - 20); // 20px from the bottom < 24 -> near

    await ctx.wrapper.setProps({ messages: build(11) });
    ctx.syncHeight(); // content gets taller once the new row hits the DOM (1100px)
    flushRaf(3);

    // scrollToBottom('smooth') lands: the viewport is carried to the content bottom.
    expect(ctx.getTop()).toBe(1100);
  });

  it('does NOT follow when 30px away from the bottom (unread instead)', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight();
    ctx.setTop(1000 - CLIENT_PX - 30); // 30px from the bottom > 24 -> away
    await ctx.scroll();

    await ctx.wrapper.setProps({ messages: build(11) });
    ctx.syncHeight();
    flushRaf(3);

    // The user was not dragged away; the message counts into the unread badge.
    expect(ctx.getTop()).toBe(670);
    const badge = ctx.wrapper.find('.scroll-badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('1');
  });
});

describe('v3 anchor persistence (stable key)', () => {
  it('saves `v3:{role}:{seq}:{offset}` (first message row below the viewport top)', async () => {
    const ctx = mountList();
    await initialLoad(ctx, [msg('a0', 0), msg('a1', 1), msg('a2', 2)]);
    // Row offsets: a0@0, a1@200, a2@400. The viewport top sits at 300 -> anchor is a2.
    offsetMapOf = (id) => Number(id.slice(1)) * 200;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');

    ctx.setTop(300);
    await ctx.scroll(); // onScroll -> saveScrollPosition (rAF coalesced)
    flushRaf(1);

    // The key is the stable server identifier (role:seq), not a random message id
    // that gets replaced on every refresh.
    expect(setSpy).toHaveBeenCalledWith('scream-scroll:s-anchor', 'v3:assistant:2:100');
    expect(localStorage.getItem('scream-scroll:s-anchor')).toBe('v3:assistant:2:100');
    setSpy.mockRestore();
  });

  it('restores the reading position by seq after a remount: a full id turnover still keeps the position', async () => {
    // First mount = the page before a refresh: leaves a reading position at old4.
    const first = mountList();
    await initialLoad(first, build(10, 'old'));
    offsetMapOf = (id) => Number(id.slice(3)) * ROW_PX;
    first.setTop(4 * ROW_PX - 100);
    await first.scroll();
    flushRaf(1);
    expect(localStorage.getItem('scream-scroll:s-anchor')).toBe('v3:assistant:4:100');
    first.wrapper.unmount();

    // Remount = after the refresh: the server resends the messages with brand new
    // ids (seq unchanged).
    const second = mountList();
    await initialLoad(second, build(10, 'new'));
    offsetMapOf = (id) => Number(id.slice(3)) * ROW_PX;
    await settleRestore(second);

    // The anchor finds the same row through seq (new4@400); the landing position is
    // row top minus the archived offset.
    expect(second.getTop()).toBe(4 * ROW_PX - 100);
    expect(second.wrapper.find('.scroll-to-bottom').exists()).toBe(false);
  });

  it('a dead anchor (seq no longer in the messages) falls back to the bottom instead of silently staying at the window top', async () => {
    localStorage.setItem('scream-scroll:s-anchor', 'v3:assistant:9999:120');
    const ctx = mountList();
    await initialLoad(ctx, build(10)); // all-new id/seq: 9999 does not exist
    ctx.syncHeight(); // 1000

    await settleRestore(ctx);

    // Bottom fallback (scrollTo down to scrollHeight) rather than staying at the
    // window top with scrollTop=0.
    expect(ctx.getTop()).toBe(ctx.el.scrollHeight);
  });

  it('a v2 archive (same-session ids, no turnover) still restores through the compatible path', async () => {
    localStorage.setItem('scream-scroll:s-anchor', 'v2:m5:50');
    const ctx = mountList();
    await initialLoad(ctx, build(200)); // window [120, 200), m5 is outside it
    offsetMapOf = (id) => Number(id.slice(1)) * ROW_PX; // m5@500; rows mounted after reveal get it too

    await settleRestore(ctx);

    // reveal path: the window slides up to m5 (REVEAL_LEAD=8, m5 index 5 -> start=0).
    expect(ctx.ids()[0]).toBe('m0');
    expect(ctx.ids()).toHaveLength(200);
    expect(ctx.getTop()).toBe(5 * ROW_PX - 50);
  });

  it('a v2 archive whose id has turned over (row not found) falls back to the bottom too', async () => {
    localStorage.setItem('scream-scroll:s-anchor', 'v2:ghost:50');
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight();

    await settleRestore(ctx);

    expect(ctx.ids()).toHaveLength(10);
    expect(ctx.getTop()).toBe(ctx.el.scrollHeight);
  });

  it('legacy numeric format keeps the expand-window restore path', async () => {
    // windowed list: 200 msgs -> window [120,200), children = 80 rows + sentinel.
    localStorage.setItem('scream-scroll:s-anchor', '9000');
    const ctx = mountList();
    await initialLoad(ctx, build(200));
    ctx.syncHeight(); // 8100

    await settleRestore(ctx);

    // Legacy behaviour: an absolute offset beyond the window's reach -> expand the
    // whole window, then restore absolutely.
    expect(ctx.ids()[0]).toBe('m0');
    expect(ctx.getTop()).toBe(9000);
  });

  it('legacy numeric format within reach restores absolutely without touching the window', async () => {
    localStorage.setItem('scream-scroll:s-anchor', '1000');
    const ctx = mountList();
    await initialLoad(ctx, build(200));
    ctx.syncHeight(); // 8100

    await settleRestore(ctx);

    expect(ctx.ids()[0]).toBe('m120'); // window was not expanded
    expect(ctx.getTop()).toBe(1000);
  });

  it('with no archive at all (first open of a session) it sticks to the bottom instead of the window top', async () => {
    const ctx = mountList();
    // First-screen content is already in place (10 rows x ROW_PX): that is the height
    // the fallback reads.
    ctx.setScrollHeight(ROW_PX * 10);
    await initialLoad(ctx, build(10));

    await settleRestore(ctx);

    expect(ctx.getTop()).toBe(ctx.el.scrollHeight);
  });
});

describe('ResizeObserver height-growth follow', () => {
  it('observes real row elements that can resize, not the scroll container itself', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));

    const targets = listResizeTargets();
    // The key regression point: observe(scroll container) never receives a
    // content-growth callback in a real browser (the container is a fixed-height box;
    // only scrollHeight changes), so that blind spot covers nothing - the target has
    // to be a row.
    expect(targets.length).toBeGreaterThan(0);
    expect(targets).not.toContain(ctx.el);
    expect(targets.every((t) => t !== ctx.el && ctx.el.contains(t))).toBe(true);
    expect(targets.map((t) => (t as HTMLElement).dataset.messageId)).toContain('m0');
  });

  it('in-row height growth through the real callback path (an observed row changed) triggers bottom follow', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight(); // 1000
    ctx.setTop(980); // at the bottom (1000 - 980 - 300 < 24)

    const row = listResizeTargets().find((t) => (t as HTMLElement).dataset.messageId === 'm0');
    expect(row).toBeDefined();
    // Images/fonts/an expanded thinking block: the DOM row count is unchanged while
    // a row grows inside -> the container box is unchanged, scrollHeight grows.
    ctx.setScrollHeight(1300);
    fireResize(row);
    flushRaf(2); // RO coalescing rAF + the rAF inside scrollToBottom

    expect(ctx.getTop()).toBe(1300); // scrollToBottom('auto') lands
  });

  it('scrolls to bottom when content grows while near the bottom', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight(); // 1000
    fireResize(); // baseline: height unchanged (it grew once at mount, but the viewport is at the top -> no pull)
    // Positioned so it is still at the bottom after the growth: 1300 - 980 - 300 = 20 < 24 (even more negative at the current height of 1000, so still near).
    ctx.setTop(980);

    // Loading images and the like: scrollHeight grows (DOM row count unchanged, rows get taller).
    ctx.setScrollHeight(1300);
    fireResize();
    flushRaf(2); // RO coalescing rAF + the rAF inside scrollToBottom

    expect(ctx.getTop()).toBe(1300); // scrollToBottom('auto') lands
  });

  it('does NOT scroll when the user is away from the bottom', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight(); // 1000
    fireResize();
    ctx.setTop(100); // 600px from the bottom

    ctx.setScrollHeight(1300);
    fireResize();
    flushRaf(1);

    expect(ctx.getTop()).toBe(100);
  });
});

describe('inertia protection', () => {
  it('cancels an in-flight smooth follow on wheel input (behavior:auto scrollTo)', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight();
    ctx.setTop(1000 - CLIENT_PX); // at the bottom

    await ctx.wrapper.setProps({ messages: build(11) }); // -> scrollToBottom('smooth')
    ctx.syncHeight();
    flushRaf(1);

    expect(ctx.getTop()).toBe(1100); // the smooth animation is under way (it lands synchronously in tests, the flag is still in flight)
    ctx.scrollToSpy.mockClear();

    ctx.el.dispatchEvent(new Event('wheel'));
    expect(ctx.scrollToSpy).toHaveBeenCalledWith({ top: 1100, behavior: 'auto' });
  });

  it('touchstart also cancels an in-flight smooth follow', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight();
    ctx.setTop(700);

    await ctx.wrapper.setProps({ messages: build(11) });
    ctx.syncHeight();
    flushRaf(1);
    ctx.scrollToSpy.mockClear();

    ctx.el.dispatchEvent(new Event('touchstart'));
    expect(ctx.scrollToSpy).toHaveBeenCalledWith({ top: 1100, behavior: 'auto' });
  });

  it('ignores wheel when no smooth animation is in flight', async () => {
    const ctx = mountList();
    await initialLoad(ctx, build(10));
    ctx.syncHeight();
    ctx.setTop(700);
    flushRaf(3); // no smooth follow happened at all
    ctx.scrollToSpy.mockClear();

    ctx.el.dispatchEvent(new Event('wheel'));
    expect(ctx.scrollToSpy).not.toHaveBeenCalled();
  });
});
