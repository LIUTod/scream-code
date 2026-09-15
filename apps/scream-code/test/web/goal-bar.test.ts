// @vitest-environment jsdom
/**
 * The one-line Goal bar pinned above the composer input.
 * Only rendering and action dispatch are covered here: goal data and writes all
 * reuse the existing client goal channel.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import GoalBar from '../../src/web/frontend/src/components/GoalBar.vue';
import type { GoalSnapshot } from '../../src/web/frontend/src/types';

function goal(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: '把登录流重构完并让测试全绿',
    status: 'active',
    turnsUsed: 3,
    tokensUsed: 1200,
    wallClockMs: 60_000,
    budget: { turnBudget: 12, tokenBudget: 200_000, wallClockMs: 900_000 },
    ...over,
  } as GoalSnapshot;
}

function mountBar(props: Record<string, unknown>) {
  return mount(GoalBar, {
    props: { goal: goal(), disabled: false, busy: false, ...props },
    global: { stubs: { SvgIcon: true } },
  });
}

describe('GoalBar takeover strip', () => {
  it('active: one line with the objective text plus pause / edit / clear', () => {
    const wrapper = mountBar({});
    expect(wrapper.find('[data-goal-bar]').exists()).toBe(true);
    expect(wrapper.find('.goal-objective').text()).toContain('把登录流重构完');
    expect(wrapper.find('[aria-label="暂停目标"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="编辑目标"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="取消目标"]').exists()).toBe(true);
    expect(wrapper.attributes('data-goal-status')).toBe('active');
  });

  it('paused / blocked: the primary action switches to "resume"', () => {
    expect(mountBar({ goal: goal({ status: 'paused' }) }).find('[aria-label="继续目标"]').exists()).toBe(true);
    const blocked = mountBar({ goal: goal({ status: 'blocked' }) });
    expect(blocked.find('[aria-label="继续目标"]').exists()).toBe(true);
    expect(blocked.attributes('data-goal-status')).toBe('blocked');
  });

  it('complete does not stay above the input (that wrapping-up view belongs to GoalPanel)', () => {
    expect(mountBar({ goal: goal({ status: 'complete' }) }).find('[data-goal-bar]').exists()).toBe(false);
    expect(mountBar({ goal: null }).find('[data-goal-bar]').exists()).toBe(false);
  });

  it('emits the three actions separately, wired by the host to the existing client channel', async () => {
    const wrapper = mountBar({});
    await wrapper.find('[aria-label="暂停目标"]').trigger('click');
    await wrapper.find('[aria-label="编辑目标"]').trigger('click');
    await wrapper.find('[aria-label="取消目标"]').trigger('click');
    expect(wrapper.emitted('pause')).toHaveLength(1);
    expect(wrapper.emitted('edit')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('while unavailable the buttons are disabled and title explains why (no silent path)', () => {
    const wrapper = mountBar({ disabled: true, disabledReason: '连接已断开，正在重连' });
    const pause = wrapper.find('[aria-label="暂停目标"]');
    expect(pause.attributes('disabled')).toBeDefined();
    expect(pause.attributes('title')).toContain('连接已断开');
  });

  it('does not re-fire an action while the request is in flight', async () => {
    const wrapper = mountBar({ pending: true });
    const pause = wrapper.find('[aria-label="暂停目标"]');
    expect(pause.attributes('disabled')).toBeDefined();
    await pause.trigger('click');
    expect(wrapper.emitted('pause')).toBeUndefined();
  });
});
