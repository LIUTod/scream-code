// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { defineComponent, ref } from 'vue';

import Composer from '../../src/web/frontend/src/components/Composer.vue';
import MenuPopover from '../../src/web/frontend/src/components/MenuPopover.vue';
import type { ModelInfo, SessionStatus } from '../../src/web/frontend/src/types';

/**
 * L2 composer capsule: one primary button with two states (idle = send,
 * busy = stop), the placeholder state machine, data-driven chip row visibility,
 * popover mutual exclusion across components, and the external draft entry point
 * insertDraft.
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
    // Attached to document so jsdom can exercise insertDraft's focus behaviour.
    attachTo: document.body,
  });
}

/** MenuPopover teleports into body, so entries are read from document. */
function menuEntries(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-entry'));
}

function clearMenu() {
  document.querySelectorAll('.menu-popover').forEach((n) => n.remove());
}

/**
 * A real click split into two phases: press (pointerdown -> mousedown) and
 * release-hit (pointerup -> mouseup -> click). A bare `.click()` skips the press
 * phase, and "the popover is dismissed by the outside-pointerdown handler during
 * press, so the click never lands on the entry" is the field bug this pins down
 * (see menu-popover-click.test.ts). Splitting the two beats lets a case assert
 * the menu is still open in between. jsdom has no PointerEvent, so MouseEvent
 * stands in for it.
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

async function typeInto(wrapper: ReturnType<typeof mountComposer>, value: string) {
  const ta = wrapper.find('.composer-input').element as HTMLTextAreaElement;
  ta.value = value;
  await wrapper.find('.composer-input').trigger('input');
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  clearMenu();
});

describe('Composer primary button states', () => {
  it('idle -> send: icon slot, aria and title stay in sync, empty input is disabled', () => {
    const wrapper = mountComposer({ busy: false });
    const btn = wrapper.find('.composer-primary');
    expect(btn.attributes('data-action')).toBe('send');
    expect(btn.attributes('aria-label')).toBe('发送');
    expect(btn.attributes('title')).toContain('发送');
    expect(btn.attributes('disabled')).toBeDefined();

    return typeInto(wrapper, '你好').then(() => {
      expect(wrapper.find('.composer-primary').attributes('disabled')).toBeUndefined();
    });
  });

  it('busy + empty input -> stop, click emits abort', async () => {
    const wrapper = mountComposer({ busy: true });
    const btn = wrapper.find('.composer-primary');
    expect(btn.attributes('data-action')).toBe('stop');
    expect(btn.attributes('aria-label')).toBe('停止');
    expect(btn.attributes('title')).toContain('停止当前回合');
    await btn.trigger('click');
    expect(wrapper.emitted('abort')).toHaveLength(1);
  });

  it('busy + non-empty input -> still stop (never morphs into queue): click aborts, input is kept in place', async () => {
    const wrapper = mountComposer({ busy: true });
    await typeInto(wrapper, '下一条');
    const btn = wrapper.find('.composer-primary');
    // Stop must stay one click away while a turn runs; this state used to be taken
    // over by queue, leaving stop unreachable.
    expect(btn.attributes('data-action')).toBe('stop');
    expect(btn.attributes('aria-label')).toBe('停止');
    expect(btn.text()).toContain('停止');
    expect(btn.attributes('title')).toContain('停止当前回合');
    // Stop is not the only way out: the queue entry point (keyboard) is documented
    // in title - the button stops, Enter queues.
    expect(btn.attributes('title')).toContain('回车把当前输入排队');
    await btn.trigger('click');
    expect(wrapper.emitted('abort')).toHaveLength(1);
    expect(wrapper.emitted('send')).toBeUndefined();
    // Nothing was queued: no queue counter chip, the draft stays with the user.
    expect(wrapper.find('[data-chip="queue"]').exists()).toBe(false);
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).value).toBe('下一条');
  });

  it('queue entry point stays on the keyboard while busy with input: Enter queues and shows the counter chip', async () => {
    const wrapper = mountComposer({ busy: true });
    await typeInto(wrapper, '下一条');
    await wrapper.find('.composer-input').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.emitted('abort')).toBeUndefined();
    expect(wrapper.emitted('send')).toBeUndefined();
    expect(wrapper.find('[data-chip="queue"]').text()).toContain('排队 1');
  });

  it('idle with input: click emits send and clears the input', async () => {
    const wrapper = mountComposer({ busy: false });
    await typeInto(wrapper, '发出去');
    await wrapper.find('.composer-primary').trigger('click');
    expect(wrapper.emitted('send')).toEqual([['发出去']]);
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).value).toBe('');
  });
});

describe('Composer placeholder state machine', () => {
  it.each([
    { case: 'default', props: {}, want: '输入消息，@ 提及文件' },
    { case: 'plan mode', props: { status: status({ planMode: true }) }, want: '计划模式' },
    { case: 'queue hint', props: { busy: true }, want: '回合进行中' },
    { case: 'offline', props: { connectionStatus: 'disconnected' }, want: '连接已断开' },
    { case: 'no workdir', props: { workDir: '' }, want: '还没有工作目录' },
  ])('$case', async ({ props, want }) => {
    const wrapper = mountComposer(props);
    expect(
      (wrapper.find('.composer-input').element as HTMLTextAreaElement).placeholder,
    ).toContain(want);
  });

  it('busy with existing input: the queue hint becomes "queue the next one"', async () => {
    const wrapper = mountComposer({ busy: true });
    expect(
      (wrapper.find('.composer-input').element as HTMLTextAreaElement).placeholder,
    ).toContain('回合进行中');
    await typeInto(wrapper, '下一条');
    expect(
      (wrapper.find('.composer-input').element as HTMLTextAreaElement).placeholder,
    ).toContain('已排队');
  });

  it('a host-supplied placeholder only applies in the default state; offline/busy are owned by the state machine', async () => {
    const wrapper = mountComposer({ placeholder: '宿主文案', busy: false });
    expect(
      (wrapper.find('.composer-input').element as HTMLTextAreaElement).placeholder,
    ).toBe('宿主文案');
    await wrapper.setProps({ busy: true });
    expect(
      (wrapper.find('.composer-input').element as HTMLTextAreaElement).placeholder,
    ).toContain('回合进行中');
  });

  it('exposes the state machine result as data-placeholder-state for styles and tests', async () => {
    const wrapper = mountComposer({ connectionStatus: 'reconnecting' });
    expect(wrapper.find('.composer-input').attributes('data-placeholder-state')).toBe('offline');
    await wrapper.setProps({ connectionStatus: 'connected', busy: true });
    expect(wrapper.find('.composer-input').attributes('data-placeholder-state')).toBe('busy');
  });
});

describe('Composer chip row (data-driven visibility)', () => {
  it('the model chip is always present; clicking opens the ModelPicker popover', async () => {
    const wrapper = mountComposer();
    const chip = wrapper.find('[data-chip="model"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('big');
    expect(wrapper.find('.model-picker').exists()).toBe(false);
    await chip.trigger('click');
    expect(wrapper.find('.model-picker').exists()).toBe(true);
  });

  it('thinking-level chip appears only with thinkingLevels; selection goes through switchThinking', async () => {
    const without = mountComposer({ status: status({ model: 'big' }) });
    expect(without.find('[data-chip="thinking"]').exists()).toBe(false);

    const withMeta = mountComposer({ status: status({ model: 'thinker', thinkingLevel: 'low' }) });
    const chip = withMeta.find('[data-chip="thinking"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('低');
    // Both opening the menu and picking an option go through the real pointer
    // sequence (a bare click cannot catch dismissal during the press phase).
    await realPress(chip.element);
    let entries = menuEntries();
    expect(entries.map((e) => e.textContent?.trim())).toEqual(['关闭', '低', '高']);
    // The press phase must not dismiss the menu: the old implementation closed it
    // on this beat, so the click always missed.
    const highEntry = entries[2]!;
    await pressDown(highEntry);
    expect(document.querySelector('.menu-popover')).not.toBeNull();
    await pressUp(highEntry);
    expect(withMeta.emitted('switch-thinking')).toEqual([['high']]);
    // Closes right after picking; no dangling popover is left behind.
    expect(menuEntries()).toHaveLength(0);
  });

  it('permission chip shows the current mode; selection goes through switchPermission and re-picking the same entry is a no-op', async () => {
    const wrapper = mountComposer();
    const permChip = wrapper.find('[data-chip="permission"]');
    expect(permChip.text()).toContain('自动');
    await realPress(permChip.element);
    const entries = menuEntries();
    const labels = entries.map((e) => e.textContent?.trim()).join('|');
    expect(labels).toContain('手动');
    expect(labels).toContain('YOLO');
    expect(labels).toContain('无人值守');
    await realPress(entries[0]!);
    expect(wrapper.emitted('switch-permission')).toEqual([['manual']]);
    expect(menuEntries()).toHaveLength(0);
  });

  it('offline: chips are disabled and title states the reason (no silent path)', () => {
    const wrapper = mountComposer({ connectionStatus: 'disconnected' });
    const model = wrapper.find('[data-chip="model"]');
    const permission = wrapper.find('[data-chip="permission"]');
    expect(model.attributes('disabled')).toBeDefined();
    expect(model.attributes('title')).toContain('连接已断开');
    expect(permission.attributes('disabled')).toBeDefined();
    expect(permission.attributes('title')).toContain('连接已断开');
  });

  it('no session: chips are disabled with a reason; an empty model list explains itself too', () => {
    const noSession = mountComposer({ sessionId: null });
    expect(noSession.find('[data-chip="permission"]').attributes('disabled')).toBeDefined();
    expect(noSession.find('[data-chip="permission"]').attributes('title')).toContain(
      '还没有打开会话',
    );
    const noModels = mountComposer({ models: [] });
    expect(noModels.find('[data-chip="model"]').attributes('disabled')).toBeDefined();
    expect(noModels.find('[data-chip="model"]').attributes('title')).toContain('没有返回可选模型');
  });

  it('the context chip takes over the ContextRing slot and is absent without data', () => {
    const withUsage = mountComposer();
    expect(withUsage.find('[data-chip="context"]').exists()).toBe(true);
    expect(withUsage.find('[data-chip="context"]').text()).toContain('42%');
    const without = mountComposer({ status: status({ contextUsage: undefined }) });
    expect(without.find('[data-chip="context"]').exists()).toBe(false);
  });

  it('the home variant has no session-scoped chips (permission/thinking) while the model capsule stays clickable', () => {
    const wrapper = mountComposer({ variant: 'home', status: undefined, sessionId: null });
    expect(wrapper.find('[data-chip="permission"]').exists()).toBe(false);
    expect(wrapper.find('[data-chip="thinking"]').exists()).toBe(false);
    const model = wrapper.find('[data-chip="model"]');
    expect(model.text()).toContain('通用智能体');
    expect(model.attributes('disabled')).toBeUndefined();
  });

  it('chips in the same row are mutually exclusive: opening thinking dismisses permission', async () => {
    const wrapper = mountComposer({ status: status({ model: 'thinker' }) });
    await wrapper.find('[data-chip="permission"]').trigger('click');
    expect(menuEntries().length).toBeGreaterThan(0);
    await wrapper.find('[data-chip="thinking"]').trigger('click');
    const open = document.querySelectorAll('.menu-popover');
    expect(open).toHaveLength(1);
    expect(open[0]?.getAttribute('aria-label')).toBe('思考力度');
    // Leave nothing open before moving on: a still-open menu would make the next
    // case's cross-component exclusion patch a panel whose DOM was already removed
    // by clearMenu (Vue throws on insertBefore for a detached node).
    wrapper.unmount();
  });
});

/**
 * Cross-component exclusion: MenuPopover's module-level registry (claimMenuSlot).
 * That registry used to live inside <script setup>, which compiles to one copy per
 * instance, so opening a menu via keyboard Enter (with no pointerdown fallback)
 * left an already-open panel elsewhere untouched and two panels were on screen at
 * the same time.
 */
const OtherMenu = defineComponent({
  components: { MenuPopover },
  setup() {
    const open = ref(false);
    const groups = [{ entries: [{ key: 'only', label: '仅此一项' }] }];
    return { open, groups };
  },
  template: `
    <MenuPopover label="别处菜单" :groups="groups" :open="open" @update:open="open = $event">
      <button class="other-trigger" @click="open = !open">别处</button>
    </MenuPopover>
  `,
});

describe('cross-component exclusion between composer chip popovers and a MenuPopover elsewhere', () => {
  it('a menu opened elsewhere dismisses the composer chip popover (module-level registry, not per-instance)', async () => {
    const composer = mountComposer();
    await composer.find('[data-chip="permission"]').trigger('click');
    expect(document.querySelectorAll('.menu-popover')).toHaveLength(1);

    const other = mount(OtherMenu, { attachTo: document.body });
    await other.find('.other-trigger').trigger('click');
    await flushPromises();

    const panels = document.querySelectorAll('.menu-popover');
    expect(panels).toHaveLength(1);
    expect(panels[0]?.getAttribute('aria-label')).toBe('别处菜单');
    composer.unmount();
    other.unmount();
  });
});

describe('Composer insertDraft (external draft entry point)', () => {
  it('puts text into the input and focuses it; activate:false fills without stealing focus', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const wrapper = mountComposer();
    wrapper.find('.composer-input').element.blur();
    const vm = wrapper.vm as unknown as {
      insertDraft: (text: string, opts?: { activate?: boolean }) => void;
    };
    vm.insertDraft('/web-clone ');
    await flushPromises();
    const el = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    expect(el.value).toBe('/web-clone ');
    expect(document.activeElement).toBe(el);

    vm.insertDraft('/push ', { activate: false });
    await flushPromises();
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).value).toBe('/push ');
  });

  it('injected text survives a session switch instead of being overwritten by the previous session draft', async () => {
    const wrapper = mountComposer();
    const vm = wrapper.vm as unknown as {
      insertDraft: (text: string, opts?: { activate?: boolean }) => void;
    };
    vm.insertDraft('/skill ');
    await flushPromises();
    // The new session has no draft yet: the injected content wins instead of
    // leaving an empty box.
    localStorage.removeItem('scream-draft:s-2');
    await wrapper.setProps({ sessionId: 's-3' });
    await flushPromises();
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).value).toBe('/skill ');
  });
});
