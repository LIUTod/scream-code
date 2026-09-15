// @vitest-environment jsdom
/**
 * Continuous-scroll thumb (the position layer of ChatMinimap). The previous
 * mechanism highlighted rows one by one through IntersectionObserver, so it
 * jumped in blocks while scrolling; the current one is a capsule mapped linearly
 * from scrollTop/scrollHeight, so this pins three things: the geometric mapping,
 * at most one update per frame, and the fade-out once scrolling stops.
 *
 * The track height comes from host.clientHeight: in jsdom the minimap itself has
 * no layout height (clientHeight 0), so the component falls back to the viewport
 * height and both the mapping baseline and the assertions stay deterministic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';

import ChatMinimap from '../../src/web/frontend/src/components/ChatMinimap.vue';
import type { ChatMessage } from '../../src/web/frontend/src/types';

/** A manual rAF queue: it lets us count how many updates a page schedules within one frame instead of guessing from microtasks. */
let rafQueue: Array<FrameRequestCallback> = [];
const rafSpy = vi.fn((cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
});
vi.stubGlobal('requestAnimationFrame', rafSpy);
vi.stubGlobal('cancelAnimationFrame', () => {});

function flushFrames(times = 1): void {
  for (let i = 0; i < times; i++) {
    const batch = rafQueue;
    rafQueue = [];
    for (const cb of batch) cb(i * 16);
  }
}

/** Wide viewport + (optionally) reduced motion. */
function stubMatchMedia({ reducedMotion = false }: { reducedMotion?: boolean } = {}): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: query.includes('min-width: 960px') || (reducedMotion && query.includes('prefers-reduced-motion')),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  );
}

vi.stubGlobal('CSS', { escape: (value: string) => value });
Element.prototype.scrollIntoView = () => {};

const CLIENT_PX = 500;

interface FakeHost extends HTMLElement {
  setScrollTop(v: number): void;
  setSize(opts: { scrollHeight?: number; clientHeight?: number }): void;
  fireScroll(): void;
  /** Read count: asserts that frame coalescing leaves exactly one DOM read per frame. */
  reads: number;
}

/** A fake scroll source: scrollHeight/clientHeight are controllable and scrollTop is read/write. */
function makeHost(scrollHeight = 2000, clientHeight = CLIENT_PX, scrollTop = 0): FakeHost {
  const el = document.createElement('div') as FakeHost;
  let top = scrollTop;
  let sh = scrollHeight;
  let ch = clientHeight;
  el.reads = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => sh });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => ch });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => {
      el.reads += 1;
      return top;
    },
  });
  el.setScrollTop = (v: number) => {
    top = v;
  };
  el.setSize = (opts) => {
    if (opts.scrollHeight !== undefined) sh = opts.scrollHeight;
    if (opts.clientHeight !== undefined) ch = opts.clientHeight;
  };
  el.fireScroll = () => {
    el.dispatchEvent(new Event('scroll'));
  };
  return el;
}

function msg(id: string, content = 'x', role = 'assistant'): ChatMessage {
  return { id, seq: Number(id.replaceAll(/\D/g, '')) || 0, role, content, tools: [], ts: 0 } as ChatMessage;
}

function build(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => msg(`m${i}`, 'hello '.repeat(i + 1)));
}

async function mountMap(host: FakeHost, messages: ChatMessage[] = build(6)) {
  const wrapper = mount(ChatMinimap, { props: { host, messages } });
  // host is MessageList's template ref and only lands on the props after the
  // first frame; this walks the same path manually.
  await wrapper.setProps({ host });
  flushFrames(2);
  await wrapper.vm.$nextTick();
  return wrapper;
}

beforeEach(() => {
  rafQueue = [];
  rafSpy.mockClear();
  vi.useRealTimers();
  stubMatchMedia();
});

/** Reads a single inline-style declaration ('' when absent) so the assertion point stays explicit and free of index-signature access. */
function styleValue(wrapper: VueWrapper, selector: string, prop: string): string {
  const raw = wrapper.find(selector).attributes('style') ?? '';
  const hit = new RegExp(`${prop}:\\s*([^;]+)`).exec(raw);
  return hit?.[1]?.trim() ?? '';
}

function styleAttr(wrapper: VueWrapper, selector: string): string {
  return wrapper.find(selector).attributes('style') ?? '';
}

describe('ChatMinimap thumb geometry', () => {
  it('maps top/height linearly from scrollTop/scrollHeight', async () => {
    const host = makeHost(2000, 500, 500);
    const wrapper = await mountMap(host);
    // height ∝ clientHeight/scrollHeight = 500/2000 -> 25% of the 500px track.
    expect(styleValue(wrapper, '.minimap-thumb', 'height')).toBe('125px');
    // top = scrollTop/scrollHeight = 500/2000 -> 125px.
    expect(styleValue(wrapper, '.minimap-thumb', 'top')).toBe('125px');

    host.setScrollTop(1000);
    host.fireScroll();
    flushFrames(1);
    await wrapper.vm.$nextTick();
    expect(styleValue(wrapper, '.minimap-thumb', 'top')).toBe('250px');
  });

  it('lands the thumb flush with the track bottom at full scroll', async () => {
    const host = makeHost(2000, 500);
    host.setScrollTop(1500); // scrollHeight - clientHeight
    const wrapper = await mountMap(host);
    // top + height === trackHeight(500): scrolled to the bottom the capsule sits
    // flush without overflowing.
    const top = parseFloat(styleValue(wrapper, '.minimap-thumb', 'top'));
    const height = parseFloat(styleValue(wrapper, '.minimap-thumb', 'height'));
    expect(top + height).toBeCloseTo(500, 5);
  });

  it('enforces the 24px minimum height on very long sessions', async () => {
    const host = makeHost(100000, 500);
    const wrapper = await mountMap(host);
    expect(styleValue(wrapper, '.minimap-thumb', 'height')).toBe('24px');
  });

  it('re-measures when the window slides without any scroll event', async () => {
    const host = makeHost(2000, 500);
    const wrapper = await mountMap(host);
    // Windowed pagination: the content grows while scrollTop stays anchored by
    // the parent list, with no scroll event fired.
    host.setSize({ scrollHeight: 4000 });
    await wrapper.setProps({ revision: 40 });
    flushFrames(1);
    await wrapper.vm.$nextTick();
    expect(styleValue(wrapper, '.minimap-thumb', 'height')).toBe('62.5px');
  });

  it('coalesces bursts of scroll events into at most one update per frame', async () => {
    const host = makeHost(2000, 500);
    const wrapper = await mountMap(host);
    // Drain the frames left over from mount (once scrollable turns true the track
    // height is measured once more).
    for (let i = 0; i < 3; i++) {
      flushFrames(1);
      await wrapper.vm.$nextTick();
    }
    rafSpy.mockClear();
    host.reads = 0;

    for (const top of [600, 700, 800, 900, 1000]) {
      host.setScrollTop(top);
      host.fireScroll();
    }
    // Five scrolls schedule a single frame, and that frame reads no DOM.
    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(host.reads).toBe(0);

    flushFrames(1);
    await wrapper.vm.$nextTick();
    // The actual measurement reads scrollTop exactly once.
    expect(host.reads).toBe(1);
    expect(styleValue(wrapper, '.minimap-thumb', 'top')).toBe('250px'); // 1000/2000*500
  });

  it('hides the whole strip when the content fits one screen', async () => {
    const host = makeHost(400, 500); // scrollHeight <= clientHeight
    const wrapper = await mountMap(host);
    expect(wrapper.find('.minimap').exists()).toBe(false);

    // Once the content overflows the bar appears as a whole, and the thumb gains
    // geometry from that moment on.
    host.setSize({ scrollHeight: 2000 });
    host.fireScroll();
    flushFrames(2);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').exists()).toBe(true);
    expect(wrapper.find('.minimap-thumb').exists()).toBe(true);
  });

  it('drops the stale mapping to opacity 0 across a session switch, then re-enters', async () => {
    const host = makeHost(2000, 500);
    const wrapper = await mountMap(host, build(6));
    expect(wrapper.find('.minimap-thumb').classes()).toContain('is-ready');

    // Session switch: the first and last messages change together, invalidating
    // the old mapping — the current frame must not keep a stale top.
    host.setScrollTop(0);
    await wrapper.setProps({ messages: build(9).map((m) => msg(`z${m.id}`, 'x')) });
    expect(wrapper.find('.minimap-thumb').classes()).not.toContain('is-ready');
    expect(styleAttr(wrapper, '.minimap-thumb')).toBe('');

    flushFrames(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap-thumb').classes()).toContain('is-ready');
    expect(styleValue(wrapper, '.minimap-thumb', 'top')).toBe('0px');
  });

  it('fades out after ~1s of stillness and wakes on the next scroll', async () => {
    // Fake the timers only, leaving the rAF queue we schedule by hand untouched.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubMatchMedia();
    const host = makeHost(2000, 500);
    const wrapper = mount(ChatMinimap, { props: { host, messages: build(6) } });
    await wrapper.setProps({ host });
    flushFrames(2);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).not.toContain('is-quiet');

    vi.advanceTimersByTime(1000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).toContain('is-quiet');

    host.fireScroll();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).not.toContain('is-quiet');
  });

  it('stays permanently visible under reduced motion (no fade timer)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubMatchMedia({ reducedMotion: true });
    const host = makeHost(2000, 500);
    const wrapper = mount(ChatMinimap, { props: { host, messages: build(6) } });
    await wrapper.setProps({ host });
    flushFrames(2);
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(10_000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).not.toContain('is-quiet');
    expect(wrapper.find('.minimap-thumb').classes()).toContain('is-ready');
  });

  it('comes back on hover and re-arms the fade timer on leave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubMatchMedia();
    const host = makeHost(2000, 500);
    const wrapper = mount(ChatMinimap, { props: { host, messages: build(6) } });
    await wrapper.setProps({ host });
    flushFrames(2);
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(1000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).toContain('is-quiet');

    // Hovering the minimap drops is-quiet (CSS steps up to the brighter hover
    // state) and the thumb comes back.
    await wrapper.find('.minimap').trigger('pointerenter');
    expect(wrapper.find('.minimap').classes()).not.toContain('is-quiet');
    expect(wrapper.find('.minimap').classes()).toContain('is-hovered');

    // After leaving it fades out only once another second of stillness passes,
    // instead of disappearing right away.
    await wrapper.find('.minimap').trigger('pointerleave');
    vi.advanceTimersByTime(900);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).not.toContain('is-quiet');
    vi.advanceTimersByTime(200);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.minimap').classes()).toContain('is-quiet');
  });

  it('keeps no per-row highlight residue (IO block mechanism is gone)', async () => {
    const host = makeHost(2000, 500);
    const wrapper = await mountMap(host);
    host.setScrollTop(1500);
    host.fireScroll();
    flushFrames(1);
    await wrapper.vm.$nextTick();
    // The in-view class from the old mechanism must not appear on any node;
    // position feedback lives in the thumb alone.
    expect(wrapper.findAll('.in-view')).toHaveLength(0);
    expect(wrapper.findAll('.minimap-block:not([class*=role-])')).toHaveLength(0);
    expect(wrapper.findAll('.minimap-thumb')).toHaveLength(1);
  });
});
