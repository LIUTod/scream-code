// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import MessageList from '../../src/web/frontend/src/components/MessageList.vue';

// Same jsdom shims as the D1 scroll suite: MessageList probes both.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  void Promise.resolve().then(() => cb(Date.now()));
  return 0;
});
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

const DAY = 24 * 60 * 60 * 1000;
// 2026-09-02 09:00 local.
const T0 = new Date(2026, 8, 2, 9, 0).getTime();

function msg(id: string, role: 'user' | 'assistant', ts?: number) {
  return { id, role, content: 'x', ts, tools: [] };
}

describe('MessageList stream dividers', () => {
  it('puts a turn hairline before every user message except the first', () => {
    const wrapper = mount(MessageList, {
      props: {
        messages: [
          msg('u1', 'user', T0),
          msg('a1', 'assistant', T0 + 60_000),
          msg('u2', 'user', T0 + 120_000),
          msg('a2', 'assistant', T0 + 180_000),
          msg('u3', 'user', T0 + 240_000),
        ],
        sessionId: 's-div',
      },
    });
    expect(wrapper.findAll('.turn-divider').length).toBe(2);
    expect(wrapper.findAll('.day-divider').length).toBe(0);
  });

  it('renders a centered date pill when adjacent messages cross local midnight', () => {
    const wrapper = mount(MessageList, {
      props: {
        messages: [
          msg('u1', 'user', T0),
          msg('a1', 'assistant', T0 + 60_000),
          msg('u2', 'user', T0 + DAY), // next day
          msg('a2', 'assistant', T0 + DAY + 60_000),
        ],
        sessionId: 's-div',
      },
    });
    const pills = wrapper.findAll('.day-divider');
    expect(pills.length).toBe(1);
    expect(pills[0]!.text()).toBe('9月3日');
    // The day pill replaces the hairline at that slot.
    expect(wrapper.findAll('.turn-divider').length).toBe(0);
  });

  it('includes the year in the pill across a year boundary', () => {
    const wrapper = mount(MessageList, {
      props: {
        messages: [
          msg('u1', 'user', T0),
          msg('u2', 'user', T0 - 300 * DAY), // ~previous year
        ],
        sessionId: 's-div',
      },
    });
    const pill = wrapper.find('.day-divider');
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
  });

  it('skips the day divider when either neighbor has no timestamp', () => {
    const wrapper = mount(MessageList, {
      props: {
        messages: [msg('u1', 'user'), msg('u2', 'user', T0)],
        sessionId: 's-div',
      },
    });
    expect(wrapper.findAll('.day-divider').length).toBe(0);
    // The user-vs-user boundary still gets its turn hairline.
    expect(wrapper.findAll('.turn-divider').length).toBe(1);
  });
});
