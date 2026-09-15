// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import Composer from '../../src/web/frontend/src/components/Composer.vue';
import ModelPicker from '../../src/web/frontend/src/components/ModelPicker.vue';
import type { ModelInfo, SessionStatus } from '../../src/web/frontend/src/types';

/**
 * ModelPicker popover positioning regression:
 * the real bug was that the popover, positioned absolutely inside .composer-chips (an
 * overflow-x:auto scroll container), was clipped entirely. The fix aligns it with
 * MenuPopover: teleport to body plus fixed positioning, driven off the capsule rect.
 * Three things are pinned here -
 *   1) the popover element hangs off document.body and is not inside .composer-chips;
 *   2) the in-place anchor remains, so the existing `wrapper.find('.model-picker')` query
 *      contract is not broken;
 *   3) the open/close contract (close / update:open) is unchanged.
 */

const MODELS: ModelInfo[] = [
  { alias: 'big', provider: 'p', model: 'm-1', maxContextSize: 200_000 },
  {
    alias: 'thinker',
    provider: 'p',
    model: 'm-2',
    maxContextSize: 200_000,
    thinkingLevels: ['off', 'low', 'high'],
  },
];

function status(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    connectionStatus: 'connected',
    model: 'big',
    permission: 'auto',
    contextUsage: 0.42,
    planMode: false,
    ...over,
  } as SessionStatus;
}

function mountComposer(over: Record<string, unknown> = {}) {
  return mount(Composer, {
    props: {
      busy: false,
      status: status(),
      sessionId: 's-1',
      models: MODELS,
      workDir: '/tmp/project',
      connectionStatus: 'connected',
      ...over,
    },
    global: { stubs: { SvgIcon: true, ContextRing: true } },
    attachTo: document.body,
  });
}

/** The popover itself: the teleported .model-picker (the in-place anchor carries a --anchor suffix and is excluded). */
function popEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.model-picker:not(.model-picker--anchor)');
}

function sweep(): void {
  document.querySelectorAll('.model-picker').forEach((n) => n.remove());
}

/**
 * A real click split into two phases: press (pointerdown -> mousedown) and release-hit
 * (pointerup -> mouseup -> click). Splitting the two beats lets a case assert that the
 * popover is not dismissed by the outside-pointerdown handler in between - the field bug
 * this pins down (see menu-popover-click.test.ts). ModelPicker binds its outside check to
 * mousedown, so both the pointer and the mouse event have to be dispatched. jsdom has no
 * PointerEvent, so MouseEvent stands in for it.
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
  localStorage.clear();
  sweep();
});

afterEach(() => {
  sweep();
});

describe('ModelPicker popover teleport positioning', () => {
  it('when open the popover element hangs off body, not inside the .composer-chips scroll container', async () => {
    const wrapper = mountComposer();
    await wrapper.find('[data-chip="model"]').trigger('click');

    const pop = popEl();
    expect(pop).not.toBeNull();
    expect(pop!.parentElement).toBe(document.body);
    expect(pop!.closest('.composer-chips')).toBeNull();
    // fixed positioning is emitted as an inline style by the shared helper (escaping the
    // ancestor overflow clip).
    expect(pop!.style.position).toBe('fixed');
    wrapper.unmount();
  });

  it('keeps the in-place anchor so the old query contract still finds .model-picker in the wrapper tree', async () => {
    const wrapper = mountComposer();
    expect(wrapper.find('.model-picker').exists()).toBe(false);
    await wrapper.find('[data-chip="model"]').trigger('click');

    const anchor = wrapper.find('.model-picker--anchor');
    expect(anchor.exists()).toBe(true);
    // The anchor is display:contents with zero layout footprint; it only marks where the
    // popover lands in the chip row.
    expect(anchor.element.closest('.composer-chips')).not.toBeNull();
    wrapper.unmount();
  });

  it('Esc / outside click / picking an entry all go through close + update:open(false)', async () => {
    const wrapper = mount(ModelPicker, {
      props: { models: MODELS, currentModel: 'big', currentThinking: 'low' },
      attachTo: document.body,
    });
    expect(popEl()).not.toBeNull();

    popEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.emitted('update:open')).toEqual([[false]]);

    // A mousedown on the trigger capsule does not count as an outside click (keeping the
    // old behaviour where clicking an already-open capsule is settled by the parent toggle).
    const chip = document.createElement('button');
    chip.className = 'composer-chip model-select';
    document.body.append(chip);
    chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);

    chip.remove();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(2);
    expect(wrapper.emitted('update:open')).toEqual([[false], [false]]);
    wrapper.unmount();
  });

  it('closes on a viewport change but ignores scrolling inside the popover list', async () => {
    const wrapper = mount(ModelPicker, {
      props: { models: MODELS, currentModel: 'big', currentThinking: 'low' },
      attachTo: document.body,
    });

    const list = popEl()!.querySelector('.picker-list')!;
    list.dispatchEvent(new Event('scroll'));
    await flushPromises();
    expect(wrapper.emitted('close')).toBeUndefined();

    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.emitted('update:open')).toEqual([[false]]);
    wrapper.unmount();
  });

  it('picking a different model through the Composer emits switch-model and removes the popover from body', async () => {
    const wrapper = mountComposer({ status: status({ model: 'thinker' }) });
    // The trigger goes through the real sequence too: opening the menu also passes the press phase.
    await realPress(wrapper.find('[data-chip="model"]').element);
    expect(popEl()).not.toBeNull();

    const row = popEl()!.querySelector<HTMLButtonElement>('.picker-row')!;
    // The press phase must not dismiss the popover (ModelPicker's outside check is on
    // mousedown, and the old implementation closed it here, leaving the following click on
    // a detached node).
    await pressDown(row);
    expect(popEl()).not.toBeNull();
    await pressUp(row);
    expect(wrapper.emitted('switch-model')).toEqual([['big']]);
    expect(popEl()).toBeNull();
    wrapper.unmount();
  });
});
