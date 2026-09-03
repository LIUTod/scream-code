// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import MessageList from '../../src/web/frontend/src/components/MessageList.vue';

// rAF as a microtask so scroll effects run inside `await nextTick()` windows.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  void Promise.resolve().then(() => cb(Date.now()));
  return 0;
});

// jsdom has no matchMedia; MessageList probes it for reduced-motion scrolling.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}));

function msg(id: string) {
  return { id, role: 'assistant' as const, content: 'x', ts: 1000, tools: [] };
}

function mountList() {
  const wrapper = mount(MessageList, { props: { messages: [], sessionId: 's1' } });
  const el = wrapper.find('.message-list').element as HTMLElement;
  // Fake a scrollable viewport: content 1000px tall, viewport 300px.
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
  let top = 700; // pinned at bottom initially (1000 - 700 - 300 = 0 < 80)
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  el.scrollTo = ((opts?: ScrollToOptions | number) => {
    if (typeof opts === 'number') top = opts;
    else if (opts && typeof opts.top === 'number') top = opts.top;
  }) as HTMLElement['scrollTo'];
  const setTop = (v: number) => {
    top = v;
  };
  const getTop = () => top;
  return { wrapper, el, setTop, getTop };
}

/** Deliver the session's initial messages (takes the restore path, not unread). */
async function initialLoad(ctx: ReturnType<typeof mountList>, messages: ReturnType<typeof msg>[]) {
  await ctx.wrapper.setProps({ messages });
  await ctx.wrapper.vm.$nextTick();
}

describe('MessageList scroll-to-bottom FAB', () => {
  it('stays hidden while pinned at the bottom', async () => {
    const ctx = mountList();
    await initialLoad(ctx, [msg('u1')]);
    expect(ctx.wrapper.find('.scroll-to-bottom').exists()).toBe(false);
  });

  it('appears when the user scrolls up', async () => {
    const ctx = mountList();
    await initialLoad(ctx, [msg('u1')]);
    ctx.setTop(0);
    ctx.el.dispatchEvent(new Event('scroll'));
    await ctx.wrapper.vm.$nextTick();
    const fab = ctx.wrapper.find('.scroll-to-bottom');
    expect(fab.exists()).toBe(true);
    expect(fab.find('.scroll-badge').exists()).toBe(false);
  });

  it('counts messages that arrive while scrolled up and clears on FAB click', async () => {
    const a = msg('a1');
    const ctx = mountList();
    await initialLoad(ctx, [a]);
    ctx.setTop(0);
    ctx.el.dispatchEvent(new Event('scroll'));
    await ctx.wrapper.vm.$nextTick();

    // Two new messages land while the view is parked at the top.
    const b = msg('a2');
    const c = msg('a3');
    await ctx.wrapper.setProps({ messages: [a, b, c] });
    await ctx.wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));

    const badge = ctx.wrapper.find('.scroll-badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('2');
    // The user was NOT yanked back down.
    expect(ctx.getTop()).toBe(0);

    // Clicking the FAB scrolls down and clears the badge.
    await ctx.wrapper.find('.scroll-to-bottom').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    await ctx.wrapper.vm.$nextTick();
    expect(ctx.wrapper.find('.scroll-badge').exists()).toBe(false);
    // rAF stand-in ran the scroll: bottom reached (scrollHeight - clientHeight).
    expect(ctx.getTop()).toBeGreaterThanOrEqual(700);
  });

  it('resets the unread badge when the user manually scrolls back to the bottom', async () => {
    const a = msg('a1');
    const ctx = mountList();
    await initialLoad(ctx, [a]);
    ctx.setTop(0);
    ctx.el.dispatchEvent(new Event('scroll'));
    await ctx.wrapper.vm.$nextTick();

    const b = msg('a2');
    await ctx.wrapper.setProps({ messages: [a, b] });
    await ctx.wrapper.vm.$nextTick();
    expect(ctx.wrapper.find('.scroll-badge').text()).toBe('1');

    ctx.setTop(700);
    ctx.el.dispatchEvent(new Event('scroll'));
    await ctx.wrapper.vm.$nextTick();
    expect(ctx.wrapper.find('.scroll-badge').exists()).toBe(false);
    expect(ctx.wrapper.find('.scroll-to-bottom').exists()).toBe(false);
  });

  it('treats the first message delivery of a session as initial load, not unread', async () => {
    const ctx = mountList();
    ctx.setTop(0);
    ctx.el.dispatchEvent(new Event('scroll'));
    await ctx.wrapper.vm.$nextTick();

    // Session opens with its first-ever messages while "scrolled up": the
    // restore path runs, no unread badge.
    await initialLoad(ctx, [msg('a1'), msg('a2')]);
    await ctx.wrapper.vm.$nextTick();
    expect(ctx.wrapper.find('.scroll-badge').exists()).toBe(false);
  });
});
