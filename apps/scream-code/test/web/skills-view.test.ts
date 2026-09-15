// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import SkillsView from '../../src/web/frontend/src/components/SkillsView.vue';
import { useToast } from '../../src/web/frontend/src/composables/useToast';

/**
 * L3 skills centre rework: the data source is client.skills (SkillSummary), with a
 * loading skeleton, empty-state guidance, a retry on failure and the "try it" fallback
 * chain.
 */

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    skills: ref<unknown[]>([]),
    skillsError: ref<string | null>(null),
    currentSessionId: ref<string | null>('sess-1'),
    fetchSkills: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mountView(client: unknown) {
  return mount(SkillsView, {
    props: { client },
    global: { stubs: { SvgIcon: true } },
  });
}

function lastToast(): string {
  const { toasts } = useToast();
  return toasts.value.at(-1)?.message ?? '';
}

afterEach(() => {
  const { toasts, removeToast } = useToast();
  [...toasts.value].forEach((t) => removeToast(t.id));
  localStorage.clear();
});

describe('SkillsView data source and states', () => {
  it('renders real skill cards: name / description / source badge (plugin sources included)', async () => {
    const client = fakeClient({
      skills: ref([
        { name: 'web-clone', description: '复刻网站方法论', source: 'user' },
        { name: 'push', description: '发布确认门', source: 'builtin', pluginId: 'managed' },
      ]),
    });
    const wrapper = mountView(client);
    await flushPromises();
    const cards = wrapper.findAll('.skill-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.text()).toContain('/web-clone');
    expect(cards[0]!.text()).toContain('复刻网站方法论');
    expect(cards[0]!.text()).toContain('用户');
    expect(cards[1]!.text()).toContain('插件 managed');
    // No longer a slash-command list (the SLASH_COMMANDS import is gone).
    expect(wrapper.text()).not.toContain('压缩会话上下文');
  });

  it('shows skeleton cards while loading and drops them once loading finishes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const client = fakeClient({ fetchSkills: vi.fn(() => pending) });
    const wrapper = mountView(client);
    await flushPromises();
    expect(wrapper.findAll('.skill-card.skeleton').length).toBeGreaterThan(0);
    release();
    await flushPromises();
    expect(wrapper.findAll('.skill-card.skeleton')).toHaveLength(0);
  });

  it('the empty state offers skill installation guidance plus a new-session button', async () => {
    const wrapper = mountView(fakeClient());
    await flushPromises();
    expect(wrapper.find('.skills-empty').exists()).toBe(true);
    expect(wrapper.text()).toContain('技能目录');
    expect(wrapper.text()).toContain('新建会话');
  });

  it('a failed load shows the error row and clicking retry fetches again', async () => {
    const client = fakeClient({ skillsError: ref('技能列表加载失败（HTTP 500）') });
    const wrapper = mountView(client);
    await flushPromises();
    expect(wrapper.find('.skills-error').text()).toContain('HTTP 500');
    await wrapper.find('.skills-retry').trigger('click');
    await flushPromises();
    expect(client.fetchSkills).toHaveBeenCalledTimes(2); // one on first mount + one on retry
  });
});

describe('SkillsView try it', () => {
  it('copy path succeeds: the clipboard receives `/skill-name `, the existing create navigation fires and a toast shows', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const client = fakeClient({
      skills: ref([{ name: 'web-clone', description: '复刻网站', source: 'user' }]),
    });
    const wrapper = mountView(client);
    await flushPromises();
    await wrapper.findAll('.skill-card .row-try, .skill-card button').find((b) => b.text().includes('试用'))!.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('/web-clone ');
    expect(wrapper.emitted('create')).toHaveLength(1);
    expect(lastToast()).toContain('已复制');
  });

  it('takes the main path when the host wires insertDraft: no draft written, clipboard untouched, no create', async () => {
    // L2 wiring consolidation: the best-effort channel that pre-wrote scream-draft is gone;
    // the main path is the host pushing text through the Composer's insertDraft.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const injectDraft = vi.fn(async () => true);
    const client = fakeClient({
      skills: ref([{ name: 'push', description: '发布确认门', source: 'extra' }]),
    });
    const wrapper = mount(SkillsView, {
      props: { client, injectDraft },
      global: { stubs: { SvgIcon: true } },
    });
    await flushPromises();
    await wrapper
      .findAll('.skill-card button')
      .find((b) => b.text().includes('试用'))!
      .trigger('click');
    await flushPromises();
    expect(injectDraft).toHaveBeenCalledWith('/push ');
    expect(writeText).not.toHaveBeenCalled();
    expect(wrapper.emitted('create')).toBeUndefined();
    expect(localStorage.getItem('scream-draft:sess-1')).toBeNull();
  });

  it('falls back to the clipboard when the host delivery fails', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const client = fakeClient({
      skills: ref([{ name: 'push', description: 'x', source: 'extra' }]),
    });
    const wrapper = mount(SkillsView, {
      props: { client, injectDraft: async () => false },
      global: { stubs: { SvgIcon: true } },
    });
    await flushPromises();
    await wrapper
      .findAll('.skill-card button')
      .find((b) => b.text().includes('试用'))!
      .trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('/push ');
    expect(wrapper.emitted('create')).toHaveLength(1);
    expect(lastToast()).toContain('已复制');
  });

  it('degrades to a typing-guidance toast when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
      configurable: true,
    });
    const client = fakeClient({
      skills: ref([{ name: 'web-clone', description: 'x', source: 'user' }]),
    });
    const wrapper = mountView(client);
    await flushPromises();
    await wrapper
      .findAll('.skill-card button')
      .find((b) => b.text().includes('试用'))!
      .trigger('click');
    await flushPromises();
    expect(lastToast()).toContain('在输入框输入 /web-clone');
    expect(wrapper.emitted('create')).toHaveLength(1);
  });
});
