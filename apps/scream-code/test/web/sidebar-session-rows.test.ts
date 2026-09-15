// @vitest-environment jsdom
/**
 * L2 sidebar session rows: the row "more" popover (rename / fork / export /
 * delete) and collapsing of groups longer than 5 rows; the time column now uses
 * the utils/relativeTime wording.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import Sidebar from '../../src/web/frontend/src/components/Sidebar.vue';
import type { SessionListItem } from '../../src/web/frontend/src/types';
import { useSidebarState, GROUP_COLLAPSE_LIMIT } from '../../src/web/frontend/src/composables/useSidebarState';

/**
 * A local "today at hh:mm" timestamp. The time column asserts relative wording
 * (today / yesterday / N days ago), so a hard-coded calendar date would rot after
 * a day boundary (the same fixture turns into "yesterday" the next day).
 */
function localTimeToday(hour: number, minute = 0): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** A local "hh:mm N calendar days ago"; month/year rollover is left to Date. */
function localTimeDaysAgo(days: number, hour: number, minute = 0): number {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function session(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    sessionId: id,
    title: `会话 ${id}`,
    workDir: '/tmp/alpha',
    createdAt: localTimeToday(8),
    messageCount: 3,
    active: false,
    archived: false,
    ...over,
  } as SessionListItem;
}

function mountSidebar(sessions: SessionListItem[], currentSessionId = 's-1') {
  return mount(Sidebar, {
    props: {
      sessions,
      currentSessionId,
      view: 'chat',
      gitStatus: null,
      busy: false,
      collapsed: false,
      workDir: null,
    },
    global: { stubs: { SvgIcon: true, FileTree: true } },
  });
}

const { toggleSpaceExpanded, expandedSpaces, query } = useSidebarState();

beforeEach(() => {
  // Sidebar state is a module-level singleton: both the search term and the
  // expanded set have to be reset.
  expandedSpaces.value = new Set();
  query.value = '';
});

describe('Sidebar row actions (always-on rename pencil + two-step delete confirm)', () => {
  it('every row carries two action buttons; the pencil is disabled with a reason on non-current sessions', () => {
    const wrapper = mountSidebar(
      [session('s-1', { active: true }), session('s-2')],
      's-1',
    );
    const rows = wrapper.findAll('.session-item-wrap');
    const acts0 = rows[0]!.findAll('.session-act');
    expect(acts0).toHaveLength(2);
    expect(acts0[0]!.attributes('aria-label')).toContain('重命名会话');
    expect(acts0[1]!.attributes('aria-label')).toContain('删除会话');
    expect(acts0[0]!.attributes('disabled')).toBeUndefined(); // the current session can be renamed
    const acts1 = rows[1]!.findAll('.session-act');
    expect(acts1[0]!.attributes('disabled')).toBeDefined();
    expect(acts1[0]!.attributes('title')).toContain('只有当前打开的会话能重命名');
    // Delete is available on every row.
    expect(acts1[1]!.attributes('disabled')).toBeUndefined();
  });

  it('clicking the pencil enters inline edit mode (rename is not emitted; the input commits)', async () => {
    const wrapper = mountSidebar([session('s-1', { active: true })]);
    await wrapper.findAll('.session-act')[0]!.trigger('click');
    await flushPromises();
    // Contract: the pencil only opens inline editing (prefilled with the current
    // title); rename-session is left to the input's commit.
    const input = wrapper.find('.rename-input');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('会话 s-1');
    expect(wrapper.emitted('rename-session')).toBeUndefined();

    // The commit path (the second half promised by the case name): typing a new
    // title and pressing Enter emits, then edit mode exits.
    await input.setValue('改过的标题');
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('rename-session')).toEqual([['s-1', '改过的标题']]);
    expect(wrapper.find('.rename-input').exists()).toBe(false);
  });

  it('delete confirm popover: the first click shows "cancel / confirm delete" without emitting; only confirm emits delete-session', async () => {
    const wrapper = mountSidebar([session('s-1', { active: true })]);
    await wrapper.findAll('.session-act')[1]!.trigger('click');
    expect(wrapper.emitted('delete-session')).toBeUndefined();
    const confirm = wrapper.find('.delete-confirm');
    expect(confirm.exists()).toBe(true);
    expect(confirm.text()).toContain('不可恢复');

    await wrapper.find('.dc-btn--danger').trigger('click');
    expect(wrapper.emitted('delete-session')).toEqual([['s-1']]);
    expect(wrapper.find('.delete-confirm').exists()).toBe(false);
  });

  it('delete popover: cancel closes without emitting; a pointerdown outside the row closes it too', async () => {
    const wrapper = mountSidebar([session('s-1', { active: true })]);
    await wrapper.findAll('.session-act')[1]!.trigger('click');
    await wrapper.find('.dc-btn').trigger('click'); // cancel
    expect(wrapper.emitted('delete-session')).toBeUndefined();
    expect(wrapper.find('.delete-confirm').exists()).toBe(false);

    await wrapper.findAll('.session-act')[1]!.trigger('click');
    // jsdom has no PointerEvent; the listener matches on the event type string, so
    // a MouseEvent stands in.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.find('.delete-confirm').exists()).toBe(false);
    expect(wrapper.emitted('delete-session')).toBeUndefined();
  });
});

describe('Sidebar time column', () => {
  it('the time column uses relative wording (today -> HH:mm)', () => {
    const wrapper = mountSidebar([session('s-1', { createdAt: localTimeToday(8) })]);
    expect(wrapper.find('.session-meta').text()).toContain('08:00');
  });

  it('a session created yesterday shows "yesterday" instead of degrading to hh:mm', () => {
    const wrapper = mountSidebar([session('s-1', { createdAt: localTimeDaysAgo(1, 8) })]);
    expect(wrapper.find('.session-meta').text()).toContain('昨天');
  });

  it('still shows "N days ago" at 7 days; anything older falls back to M/D', () => {
    const recent = mountSidebar([session('s-1', { createdAt: localTimeDaysAgo(3, 8) })]);
    expect(recent.find('.session-meta').text()).toContain('3 天前');
    const old = mountSidebar([session('s-1', { createdAt: localTimeDaysAgo(9, 8) })]);
    const d = new Date(localTimeDaysAgo(9, 8));
    expect(old.find('.session-meta').text()).toContain(`${d.getMonth() + 1}/${d.getDate()}`);
  });
});

describe('Sidebar group collapse', () => {
  it(`collapses by default beyond ${GROUP_COLLAPSE_LIMIT} rows and offers "show N more"`, () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s-${i}`));
    const wrapper = mountSidebar(many);
    expect(wrapper.findAll('.session-item')).toHaveLength(GROUP_COLLAPSE_LIMIT);
    const more = wrapper.find('.space-more');
    expect(more.exists()).toBe(true);
    expect(more.text()).toContain('显示更多 3 条');
  });

  it('clicking "show more" expands everything and collapses again', async () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s-${i}`));
    const wrapper = mountSidebar(many);
    await wrapper.find('.space-more').trigger('click');
    expect(wrapper.findAll('.session-item')).toHaveLength(8);
    expect(wrapper.find('.space-more').text()).toContain('收起');
    await wrapper.find('.space-more').trigger('click');
    expect(wrapper.findAll('.session-item')).toHaveLength(GROUP_COLLAPSE_LIMIT);
  });

  it('no collapse while searching (hiding results would read as "there is nothing")', async () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s-${i}`));
    const wrapper = mountSidebar(many);
    const search = wrapper.find('.side-search input');
    await search.setValue('会话');
    expect(wrapper.findAll('.session-item')).toHaveLength(8);
    expect(wrapper.find('.space-more').exists()).toBe(false);
  });

  it('no collapse button below the threshold', () => {
    const few = Array.from({ length: GROUP_COLLAPSE_LIMIT }, (_, i) => session(`s-${i}`));
    const wrapper = mountSidebar(few);
    expect(wrapper.findAll('.session-item')).toHaveLength(GROUP_COLLAPSE_LIMIT);
    expect(wrapper.find('.space-more').exists()).toBe(false);
  });

  it('the expanded state is shared across Sidebar instances (module-level singleton)', async () => {
    const many = Array.from({ length: 7 }, (_, i) => session(`s-${i}`));
    const a = mountSidebar(many);
    await a.find('.space-more').trigger('click');
    toggleSpaceExpanded('/tmp/alpha'); // another instance (mobile drawer) hits the same group -> collapse
    await a.vm.$nextTick();
    expect(a.findAll('.session-item')).toHaveLength(GROUP_COLLAPSE_LIMIT);
  });
});


describe('Sidebar row meta counts (messageCount = -1 means unknown)', () => {
  it('a known count renders "N items"; an unknown count (-1, archived and inactive) hides the count and keeps the time', () => {
    const wrapper = mountSidebar([
      session('s-known', { messageCount: 8, active: true }),
      session('s-unknown', { messageCount: -1 }),
    ]);
    const metas = wrapper.findAll('.session-meta');
    expect(metas[0]!.text()).toContain('8 条');
    expect(metas[0]!.text()).toContain('·');
    // Unknown count: never render a nonsense "-1 items", and leave no dangling
    // separator either.
    expect(metas[1]!.text()).not.toContain('条');
    expect(metas[1]!.find('.meta-sep').exists()).toBe(false);
    // The time is still there, so the row keeps its height rhythm.
    expect(metas[1]!.text().trim().length).toBeGreaterThan(0);
  });
});
