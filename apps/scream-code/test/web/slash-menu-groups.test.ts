// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';

import SlashMenu from '../../src/web/frontend/src/components/SlashMenu.vue';
import {
  filterSlashCommands,
  resetSlashMenuFilter,
  setSlashSkills,
  type SlashCommand,
} from '../../src/web/frontend/src/commands';

/**
 * Slash-menu rendering: command group + skill group + group labels + the search
 * filter row (>8 candidates). The test harness mirrors how Composer consumes the
 * catalogue (computed(filterSlashCommands)), proving that the module-level state
 * in commands.ts (skill injection / menu filter) drives the menu refresh.
 */

const harnessQuery = ref('');
const Harness = defineComponent({
  setup() {
    const candidates = computed(() => filterSlashCommands(harnessQuery.value));
    return () => h(SlashMenu, { commands: candidates.value as SlashCommand[], activeIndex: 0 });
  },
});

async function type(query: string) {
  harnessQuery.value = query;
  await nextTick();
}

afterEach(() => {
  harnessQuery.value = '';
  setSlashSkills([]);
  resetSlashMenuFilter();
});

describe('SlashMenu group rendering', () => {
  it('empty query: core commands are listed while the advanced group only keeps its collapsed hint', () => {
    setSlashSkills([{ name: 'web-clone', description: '复刻网站', source: 'user' }]);
    const wrapper = mount(Harness);
    const groups = wrapper.findAll('.slash-group-label').map((n) => n.text());
    expect(groups).toEqual(expect.arrayContaining(['命令', '技能']));
    const collapsed = wrapper.findAll('.slash-group').find((n) => n.text().includes('高级'));
    expect(collapsed).toBeTruthy();
    expect(collapsed!.text()).toContain('输入继续筛选');
    const names = wrapper.findAll('.slash-name').map((n) => n.text());
    expect(names).not.toContain('/bot');
    expect(names.some((n) => n.startsWith('/web-clone'))).toBe(true);
  });

  it('skill entries show the skill description and badge, placed after the command group', () => {
    setSlashSkills([{ name: 'push', description: '发布确认门', pluginId: 'pack' }]);
    const wrapper = mount(Harness);
    const items = wrapper.findAll('.slash-item');
    const last = items.at(-1)!;
    expect(last.text()).toContain('/push');
    expect(last.text()).toContain('发布确认门');
    expect(last.text()).toContain('技能');
    expect(last.text()).toContain('插件 pack');
  });

  it('a query hitting an advanced command expands the advanced group', async () => {
    const wrapper = mount(Harness);
    await type('bo');
    const groups = wrapper.findAll('.slash-group-label').map((n) => n.text());
    expect(groups).toContain('高级');
    expect(wrapper.findAll('.slash-name').map((n) => n.text()).some((t) => t.startsWith('/bot'))).toBe(true);
  });
});

describe('SlashMenu search filter row', () => {
  it('hides the filter row at ≤8 candidates; above 8 (commands + skills) it appears and narrows the list', async () => {
    const small = mount(Harness);
    expect(small.find('.slash-search-input').exists()).toBe(false);
    small.unmount();

    setSlashSkills(
      Array.from({ length: 4 }, (_, i) => ({ name: `sk-${i}`, description: `技能 ${i}`, source: 'user' })),
    );
    const wrapper = mount(Harness);
    const input = wrapper.find('.slash-search-input');
    expect(input.exists()).toBe(true);
    expect(wrapper.findAll('.slash-item').length).toBeGreaterThan(8);
    await input.setValue('sk-2');
    const names = wrapper.findAll('.slash-name').map((n) => n.text());
    expect(names).toEqual(['/sk-2']);
    // The filter state lives in commands.ts: unmounting (menu closed) resets it,
    // so the next open is not polluted.
    wrapper.unmount();
    expect(filterSlashCommands('').length).toBeGreaterThan(1);
  });

  it('clicking a skill entry emits the whole item via select (acceptsInput makes the host fill in text)', async () => {
    setSlashSkills([{ name: 'web-clone', description: '复刻网站', source: 'user' }]);
    const wrapper = mount(SlashMenu, {
      props: { commands: filterSlashCommands('web'), activeIndex: 0 },
    });
    const item = wrapper.find('.slash-item');
    expect(item.text()).toContain('/web-clone');
    await item.trigger('mousedown');
    const emitted = wrapper.emitted('select');
    expect(emitted?.[0]?.[0]).toMatchObject({ name: 'web-clone', kind: 'skill', acceptsInput: true });
  });
});
