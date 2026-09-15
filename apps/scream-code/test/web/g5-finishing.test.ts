// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatMinimap from '../../src/web/frontend/src/components/ChatMinimap.vue';
import type { ChatMessage } from '../../src/web/frontend/src/types';

// rAF as a microtask: minimap measurement goes through the frame-coalescing
// path, so a single settle is enough.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  void Promise.resolve().then(() => cb(Date.now()));
  return 1;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

function msg(partial: Partial<ChatMessage> & { id: string; content: string }): ChatMessage {
  return { role: 'assistant', seq: 0, tools: [], ts: 0, ...partial } as ChatMessage;
}

/**
 * Fake scroll source: the minimap now renders only when the content really
 * overflows (scrollHeight > clientHeight), so the host must carry layout numbers
 * — a bare div reports 0 for both in jsdom.
 */
function makeHost(scrollHeight = 2000, clientHeight = 500): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0 });
  return el;
}

async function settle(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe('ChatMinimap (G5.1)', () => {
  it('renders a faint density block per message with role classes', async () => {
    // jsdom has no matchMedia; stub one that reports a wide viewport so the
    // minimap enables, as it would on a real desktop screen.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    const wrapper = mount(ChatMinimap, {
      props: {
        host: makeHost(),
        messages: [
          msg({ id: 'a', role: 'user', content: 'hi' }),
          msg({ id: 'b', role: 'assistant', content: 'hello there'.repeat(20) }),
          msg({ id: 'c', role: 'tool', content: 'x' }),
        ],
      },
      global: { stubs: { SvgIcon: true } },
    });
    await settle(wrapper);
    const blocks = wrapper.findAll('.minimap-block');
    expect(blocks.length).toBe(3);
    expect(blocks[0].classes()).toContain('role-user');
    expect(blocks[1].classes()).toContain('role-assistant');
    expect(blocks[2].classes()).toContain('role-tool');
    // The long assistant message must claim more vertical space than a short one.
    const h0 = parseFloat(blocks[0].attributes('style')!.match(/height: ([0-9.]+)%/)?.[1] ?? '0');
    const h1 = parseFloat(blocks[1].attributes('style')!.match(/height: ([0-9.]+)%/)?.[1] ?? '0');
    expect(h1).toBeGreaterThan(h0);
    // Block layer: no in-view highlight state anymore (position feedback is owned
    // by the thumb alone).
    expect(wrapper.find('.in-view').exists()).toBe(false);
  });

  it('is inert without matchMedia (jsdom has none) and never throws', async () => {
    // The previous test stubbed matchMedia; restore the bare-jsdom absence so
    // this test exercises the guard path (enabled stays false → no render).
    Object.defineProperty(window, 'matchMedia', { writable: true, value: undefined });
    const wrapper = mount(ChatMinimap, {
      props: { host: makeHost(), messages: [msg({ id: 'a', role: 'user', content: 'hi' })] },
      global: { stubs: { SvgIcon: true } },
    });
    await settle(wrapper);
    // enabled stays false without matchMedia, so nothing is rendered.
    expect(wrapper.find('.minimap').exists()).toBe(false);
  });
});
