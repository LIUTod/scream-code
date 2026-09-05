// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatMinimap from '../../src/web/frontend/src/components/ChatMinimap.vue';
import EmptyState from '../../src/web/frontend/src/components/EmptyState.vue';
import type { ChatMessage } from '../../src/web/frontend/src/types';

function msg(partial: Partial<ChatMessage> & { id: string; content: string }): ChatMessage {
  return { role: 'assistant', seq: 0, tools: [], ts: 0, ...partial } as ChatMessage;
}

describe('ChatMinimap (G5.1)', () => {
  it('renders a block per message with role classes', () => {
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
    const host = document.createElement('div');
    const wrapper = mount(ChatMinimap, {
      props: {
        host,
        messages: [
          msg({ id: 'a', role: 'user', content: 'hi' }),
          msg({ id: 'b', role: 'assistant', content: 'hello there'.repeat(20) }),
          msg({ id: 'c', role: 'tool', content: 'x' }),
        ],
      },
      global: { stubs: { SvgIcon: true } },
    });
    const blocks = wrapper.findAll('.minimap-block');
    expect(blocks.length).toBe(3);
    expect(blocks[0].classes()).toContain('role-user');
    expect(blocks[1].classes()).toContain('role-assistant');
    expect(blocks[2].classes()).toContain('role-tool');
    // The long assistant message must claim more vertical space than a short one.
    const h0 = parseFloat(blocks[0].attributes('style')!.match(/height: ([0-9.]+)%/)?.[1] ?? '0');
    const h1 = parseFloat(blocks[1].attributes('style')!.match(/height: ([0-9.]+)%/)?.[1] ?? '0');
    expect(h1).toBeGreaterThan(h0);
  });

  it('is inert without matchMedia (jsdom has none) and never throws', () => {
    // The previous test stubbed matchMedia; restore the bare-jsdom absence so
    // this test exercises the guard path (enabled stays false → no render).
    Object.defineProperty(window, 'matchMedia', { writable: true, value: undefined });
    const host = document.createElement('div');
    const wrapper = mount(ChatMinimap, {
      props: { host, messages: [msg({ id: 'a', role: 'user', content: 'hi' })] },
      global: { stubs: { SvgIcon: true } },
    });
    // enabled stays false without matchMedia, so nothing is rendered.
    expect(wrapper.find('.minimap').exists()).toBe(false);
  });
});

describe('EmptyState recent prompts (G5.5)', () => {
  it('renders recent prompt chips from localStorage', async () => {
    localStorage.setItem('scream-recent-prompts', JSON.stringify(['fix the build', 'explain lsp']));
    const wrapper = mount(EmptyState, {
      props: { workDir: '/tmp/wd', connected: true },
      global: { stubs: { SvgIcon: true } },
    });
    await wrapper.vm.$nextTick();
    const chips = wrapper.findAll('.recent-chip').map((n) => n.text());
    expect(chips).toContain('fix the build');
    expect(chips).toContain('explain lsp');
    localStorage.removeItem('scream-recent-prompts');
  });

  it('emits pick when a recent chip is clicked', async () => {
    localStorage.setItem('scream-recent-prompts', JSON.stringify(['debug the crash']));
    const wrapper = mount(EmptyState, {
      props: { workDir: '/tmp/wd', connected: true },
      global: { stubs: { SvgIcon: true } },
    });
    await wrapper.vm.$nextTick();
    await wrapper.find('.recent-chip').trigger('click');
    expect(wrapper.emitted('pick')![0]![0]).toBe('debug the crash');
    localStorage.removeItem('scream-recent-prompts');
  });
});
