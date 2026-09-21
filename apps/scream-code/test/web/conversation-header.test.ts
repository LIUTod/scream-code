// @vitest-environment jsdom
/**
 * L2 top bar consolidation: flat actions move into a "more" popover, and the stats
 * capsule carries turns/tokens and opens the stats panel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import ConversationHeader from '../../src/web/frontend/src/components/ConversationHeader.vue';
import { dockPanel, setDockOpen } from '../../src/web/frontend/src/utils/fileTabState';

function mountHeader(over: Record<string, unknown> = {}) {
  return mount(ConversationHeader, {
    props: {
      title: '重构登录流',
      busy: false,
      statsOpen: false,
      turnTokens: 12_345,
      turnCount: 4,
      ...over,
    },
    global: { stubs: { SvgIcon: true } },
  });
}

function menuEntries(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-entry'));
}

/**
 * A real click split into two phases: press (pointerdown -> mousedown) and release-hit
 * (pointerup -> mouseup -> click). Splitting the two beats lets a case assert that the
 * popover is not dismissed by the outside-pointerdown handler in between - the field
 * bug this pins down (see menu-popover-click.test.ts). Both the trigger and the entries
 * go through this path; no case should take a shortcut. jsdom has no PointerEvent, so
 * MouseEvent stands in for it.
 */
async function pressDown(el: Element): Promise<void> {
  const opts = { bubbles: true, cancelable: true } as const;
  el.dispatchEvent(new MouseEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  await nextTick();
}

async function pressUp(el: Element): Promise<void> {
  const opts = { bubbles: true, cancelable: true } as const;
  el.dispatchEvent(new MouseEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  await flushPromises();
}

/** A full real click = press + release. */
async function realPress(el: Element): Promise<void> {
  await pressDown(el);
  await pressUp(el);
}

beforeEach(() => {
  document.querySelectorAll('.menu-popover').forEach((n) => n.remove());
});

describe('ConversationHeader more popover', () => {
  it('the flat area keeps only back / title / stats capsule / dock, while export and clear move into the popover', () => {
    const wrapper = mountHeader();
    const bar = wrapper.find('.conv-bar');
    expect(bar.find('.back-btn').exists()).toBe(true);
    expect(bar.find('.title-btn').text()).toContain('重构登录流');
    expect(bar.find('.stats-btn').exists()).toBe(true);
    expect(bar.find('.more-btn').exists()).toBe(true);
    // The old flat buttons no longer appear in the top bar (the title attribute was
    // their only identifier at the time).
    expect(bar.find('[title="导出 Markdown"]').exists()).toBe(false);
    expect(bar.find('[title="清空本会话消息"]').exists()).toBe(false);
  });

  it('clicking "more" toggles the popover, whose entries cover export / clear / file panel', async () => {
    const wrapper = mountHeader();
    expect(menuEntries()).toHaveLength(0);
    await realPress(wrapper.find('.more-btn').element);
    const labels = menuEntries().map((e) => e.textContent?.trim());
    expect(labels).toEqual([
      '会话控制',
      '协作代理',
      '导出 Markdown',
      '分叉会话',
      '清空本地消息',
      expect.stringContaining('文件面板'),
    ]);
    expect(wrapper.find('.more-btn').attributes('aria-expanded')).toBe('true');
    await realPress(wrapper.find('.more-btn').element);
    expect(menuEntries()).toHaveLength(0);
    expect(wrapper.find('.more-btn').attributes('aria-expanded')).toBe('false');
  });

  it('export and clear each emit, and the popover closes right after picking', async () => {
    const wrapper = mountHeader();
    await realPress(wrapper.find('.more-btn').element);
    const exportEntry = menuEntries().find((entry) => entry.textContent?.includes('导出 Markdown'))!;
    // The press phase must not dismiss the popover (the old implementation closed it on
    // this beat, so the click never landed on the entry).
    await pressDown(exportEntry);
    expect(document.querySelector('.menu-popover')).not.toBeNull();
    await pressUp(exportEntry);
    expect(wrapper.emitted('export')).toHaveLength(1);
    expect(menuEntries()).toHaveLength(0);

    await realPress(wrapper.find('.more-btn').element);
    await realPress(menuEntries().find((entry) => entry.textContent?.includes('清空本地消息'))!);
    expect(wrapper.emitted('clear')).toHaveLength(1);
  });

  it('with an empty session (no turns, no tokens) export/clear are disabled and state the reason', async () => {
    const wrapper = mountHeader({ turnTokens: null, turnCount: null });
    await realPress(wrapper.find('.more-btn').element);
    const exportItem = menuEntries().find((e) => e.textContent?.includes('导出'));
    const clearItem = menuEntries().find((e) => e.textContent?.includes('清空'));
    expect(exportItem!.disabled).toBe(true);
    expect(exportItem!.title).toContain('还没有消息可导出');
    expect(clearItem!.disabled).toBe(true);
    expect(clearItem!.title).toContain('还没有消息可清空');
  });

  it('the stats capsule shows turns/tokens and emits toggle-stats; pointerdown does not bubble', async () => {
    const wrapper = mountHeader();
    const pill = wrapper.find('.stats-btn');
    expect(pill.text()).toContain('4 轮');
    expect(pill.text()).toContain('12.3k');
    await pill.trigger('pointerdown');
    expect(wrapper.emitted('toggle-stats')).toBeUndefined();
    await pill.trigger('click');
    expect(wrapper.emitted('toggle-stats')).toHaveLength(1);
  });

  it('without token data the capsule degrades to an icon instead of showing an empty number', () => {
    const wrapper = mountHeader({ turnTokens: null, turnCount: 0 });
    const pill = wrapper.find('.stats-btn');
    expect(pill.text().trim()).toBe('');
  });

  it('the dock button keeps its L1 semantics (open = expand the detail popover, collapse = hide the whole dock)', async () => {
    setDockOpen(false);
    const wrapper = mountHeader();
    const dock = () => wrapper.findAll('.ghost-btn').at(-1)!;
    expect(dock().attributes('title')).toBe('打开右栏');
    await dock().trigger('click');
    expect(dockPanel.panelOpen).toBe(true);
    expect(dockPanel.tabs.some((t) => t.kind === 'detail')).toBe(true);
    // The collapsed title changes from "open dock" to "collapse dock", and clicking once
    // more collapses the whole dock.
    await wrapper.vm.$nextTick();
    expect(dock().attributes('title')).toBe('收起右栏');
    await dock().trigger('click');
    expect(dockPanel.panelOpen).toBe(false);
  });
});
