// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';

import Composer from '../../src/web/frontend/src/components/Composer.vue';
import { resetSlashMenuFilter, setSlashSkills } from '../../src/web/frontend/src/commands';

/**
 * End-to-end selection semantics (Composer source untouched): skill entries carry
 * acceptsInput=true, so the existing pickSlashCommand logic fills the input with
 * `/skill-name ` as plain text instead of executing right away; only the
 * following Enter runs command dispatch (which the host routes to skill
 * activation).
 */

afterEach(() => {
  setSlashSkills([]);
  resetSlashMenuFilter();
});

function mountComposer() {
  return mount(Composer, {
    props: { busy: false, sessionId: 'test-session' },
    global: { stubs: { SvgIcon: true } },
  });
}

describe('Composer slash-skill selection', () => {
  it('picking a skill entry fills the input with `/skill-name ` text and emits no command', async () => {
    setSlashSkills([{ name: 'web-clone', description: '复刻网站', source: 'user' }]);
    const wrapper = mountComposer();
    await wrapper.find('textarea').setValue('/web');
    const items = wrapper.findAll('.slash-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.text()).toContain('/web-clone');
    await items[0]!.trigger('mousedown');
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('/web-clone ');
    expect(wrapper.emitted('command')).toBeUndefined();
  });

  it('Enter after the fill emits command (the host dispatcher routes activation by skill name)', async () => {
    setSlashSkills([{ name: 'push', description: '发布确认门', source: 'extra' }]);
    const wrapper = mountComposer();
    await wrapper.find('textarea').setValue('/push 发包前先读脚本');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    const emitted = wrapper.emitted('command');
    expect(emitted?.[0]).toEqual(['push', '发包前先读脚本']);
  });

  it('a skill injection later than mount still refreshes the menu (the merged candidates are reactive)', async () => {
    const wrapper = mountComposer();
    await wrapper.find('textarea').setValue('/late');
    expect(wrapper.find('.slash-menu').exists()).toBe(false);
    setSlashSkills([{ name: 'late-skill', description: '迟到技能', source: 'project' }]);
    // The skill source changes → Composer's slashCommands computed recomputes and
    // drives a re-render.
    await nextTick();
    expect(wrapper.find('.slash-menu').exists()).toBe(true);
    expect(wrapper.find('.slash-item').text()).toContain('/late-skill');
  });
});

describe('Composer slash-menu outside-click discipline', () => {
  it('clicking outside the composer closes the menu; editing the slash query brings it back', async () => {
    const wrapper = mountComposer();
    const box = wrapper.find('textarea');
    await box.setValue('/');
    expect(wrapper.find('.slash-menu').exists()).toBe(true);

    // Clicking the message area or any other spot outside the composer: the
    // mousedown bubbles to document and dismisses the menu.
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(wrapper.find('.slash-menu').exists()).toBe(false);

    // The dismissal only applies to the current query context: typing on brings
    // the menu back (the watch resets it).
    await box.setValue('/cl');
    expect(wrapper.find('.slash-menu').exists()).toBe(true);
    wrapper.unmount();
  });
});
