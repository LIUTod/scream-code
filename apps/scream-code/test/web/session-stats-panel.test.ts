// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionStatsPanel from '../../src/web/frontend/src/components/SessionStatsPanel.vue';
import type { SessionStatus } from '../../src/web/frontend/src/types';

const noop = (): Promise<void> => Promise.resolve();

function statusOf(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return { busy: false, ...overrides };
}

describe('SessionStatsPanel', () => {
  it('renders the context watermark as a progress bar from tokens', () => {
    const wrapper = mount(SessionStatsPanel, {
      props: {
        status: statusOf({ contextTokens: 2500, maxContextTokens: 10000 }),
        fetchUsage: noop,
        fetchContext: noop,
      },
    });
    const bar = wrapper.find('.ctx-track');
    expect(bar.exists()).toBe(true);
    expect(bar.attributes('aria-valuenow')).toBe('25');
    expect(wrapper.text()).toContain('2,500 / 10,000');
  });

  it('accepts contextUsage as a fraction or percent', () => {
    const frac = mount(SessionStatsPanel, {
      props: { status: statusOf({ contextUsage: 0.4 }), fetchUsage: noop, fetchContext: noop },
    });
    expect(frac.find('.ctx-track').attributes('aria-valuenow')).toBe('40');

    const pct = mount(SessionStatsPanel, {
      props: { status: statusOf({ contextUsage: 60 }), fetchUsage: noop, fetchContext: noop },
    });
    expect(pct.find('.ctx-track').attributes('aria-valuenow')).toBe('60');
  });

  it('shows the current-turn token total when present', () => {
    const wrapper = mount(SessionStatsPanel, {
      props: {
        status: statusOf({ usage: { currentTurn: { inputOther: 100, output: 50, inputCacheRead: 20, inputCacheCreation: 30 } } }),
        fetchUsage: noop,
        fetchContext: noop,
      },
    });
    expect(wrapper.text()).toContain('当前回合');
    expect(wrapper.text()).toContain('200 tokens');
  });

  it('shows session totals with all four token dimensions', () => {
    const wrapper = mount(SessionStatsPanel, {
      props: {
        status: statusOf({ usage: { total: { inputOther: 1000, output: 400, inputCacheRead: 300, inputCacheCreation: 200 } } }),
        fetchUsage: noop,
        fetchContext: noop,
      },
    });
    expect(wrapper.text()).toContain('本会话累计');
    expect(wrapper.text()).toContain('1.9k tokens');
    for (const label of ['输入', '输出', '缓存读', '缓存写']) {
      expect(wrapper.text()).toContain(label);
    }
  });

  it('breaks totals down by model', () => {
    const wrapper = mount(SessionStatsPanel, {
      props: {
        status: statusOf({
          usage: {
            total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
            byModel: {
              'model-a': { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 },
              'model-b': { inputOther: 0, output: 0, inputCacheRead: 200, inputCacheCreation: 50 },
            },
          },
        }),
        fetchUsage: noop,
        fetchContext: noop,
      },
    });
    expect(wrapper.text()).toContain('model-a');
    expect(wrapper.text()).toContain('model-b');
    expect(wrapper.text()).toContain('按模型');
  });

  it('shows the empty state when there is no usage data', () => {
    const wrapper = mount(SessionStatsPanel, {
      props: { status: statusOf({}), fetchUsage: noop, fetchContext: noop },
    });
    expect(wrapper.text()).toContain('暂无用量数据');
  });

  it('fetches usage and context on mount', () => {
    const fetchUsage = vi.fn(noop);
    const fetchContext = vi.fn(noop);
    mount(SessionStatsPanel, { props: { status: statusOf({}), fetchUsage, fetchContext } });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(fetchContext).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on outside pointerdown, but not on inside clicks', async () => {
    const wrapper = mount(SessionStatsPanel, {
      props: { status: statusOf({}), fetchUsage: noop, fetchContext: noop },
    });
    const panel = wrapper.find('.stats-panel');

    // Pointer down inside must not close.
    await panel.trigger('pointerdown');
    expect(wrapper.emitted('close')).toBeUndefined();

    // Pointer down outside closes (jsdom lacks PointerEvent; MouseEvent with
    // the pointerdown type is enough — the handler only reads e.target).
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    // Escape closes too (mount a fresh copy; the listener is global).
    const second = mount(SessionStatsPanel, {
      props: { status: statusOf({}), fetchUsage: noop, fetchContext: noop },
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(second.emitted('close')).toHaveLength(1);
  });
});

describe('ConversationHeader stats toggle (regression)', () => {
  it('toggle button stops pointerdown so outside-click close cannot eat the toggle', async () => {
    const ConversationHeader = (await import('../../src/web/frontend/src/components/ConversationHeader.vue')).default;
    const wrapper = mount(ConversationHeader, {
      props: { title: 't', busy: false, drawerOpen: false, statsOpen: true, turnTokens: null },
      global: { stubs: { SvgIcon: true } },
    });
    // With statsOpen already true, a plain click toggles it off. Without
    // @pointerdown.stop the panel's global pointerdown listener would fire
    // first (close) and the click would re-open it — the panel would never
    // close. We assert the emitted toggle is not swallowed.
    const btn = wrapper.find('.stats-btn');
    await btn.trigger('pointerdown');
    await btn.trigger('click');
    const emitted = wrapper.emitted('toggle-stats');
    expect(emitted).toHaveLength(1);
  });
});
