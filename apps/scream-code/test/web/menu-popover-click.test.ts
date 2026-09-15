// @vitest-environment jsdom
/**
 * MenuPopover real click-path regression.
 *
 * Observed in practice: the outside-close listener runs in the document capture
 * phase and decided ownership from the trigger (.menu-root) alone, while the
 * popover body is teleported to body — so pointerdown closed the menu before the
 * click could ever land on an entry. The symptom was "the menu opens, but picking
 * an option does nothing", which hit the permission chip, the thinking effort
 * selector and the header "more" menu alike.
 *
 * These cases dispatch events in real order, stage by stage (pointerdown →
 * assert the menu is still open → click); a synthetic click fired all at once
 * cannot expose the bug — which is exactly why it stayed hidden.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';

import MenuPopover from '../../src/web/frontend/src/components/MenuPopover.vue';

const Host = defineComponent({
  components: { MenuPopover },
  setup() {
    const open = ref(true);
    const picked = ref<string | null>(null);
    const groups = [
      {
        entries: [
          { key: 'manual', label: '手动' },
          { key: 'auto', label: '自动' },
        ],
      },
    ];
    return { open, picked, groups };
  },
  template: `
    <MenuPopover label="权限模式" :groups="groups" :open="open"
      @select="picked = $event" @update:open="open = $event">
      <button class="trigger">权限</button>
    </MenuPopover>
  `,
});

function panel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.menu-popover');
}
function entries(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('.menu-entry'));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('MenuPopover entry clicks (ownership after teleporting to body)', () => {
  it('pointerdown on a popover entry keeps the menu open and the following click emits select', async () => {
    const wrapper = mount(Host, { attachTo: document.body });
    await nextTick();
    expect(panel()).not.toBeNull();

    const item = entries()[1]!;
    // Step one of the real order: pointerdown (an implementation that only checks
    // the trigger already closes the menu here).
    item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(panel()).not.toBeNull();

    // Step two of the real order: the click must still land.
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(wrapper.vm.picked).toBe('auto');
    wrapper.unmount();
  });

  it('pointerdown on blank popover space (the panel itself) does not close either', async () => {
    const wrapper = mount(Host, { attachTo: document.body });
    await nextTick();
    const pop = panel()!;
    pop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(panel()).not.toBeNull();
    wrapper.unmount();
  });

  it('pointerdown on the trigger does not close (collapsing on a self-click stays with the parent toggle)', async () => {
    const wrapper = mount(Host, { attachTo: document.body });
    await nextTick();
    wrapper.find('.trigger').element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    await nextTick();
    expect(panel()).not.toBeNull();
    wrapper.unmount();
  });

  it('pointerdown on a genuine outside area (elsewhere in body) still closes', async () => {
    const wrapper = mount(Host, { attachTo: document.body });
    await nextTick();
    const outside = document.createElement('div');
    document.body.append(outside);
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await nextTick();
    expect(panel()).toBeNull();
    wrapper.unmount();
  });
});
