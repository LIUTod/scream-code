// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ModeSwitch from '../../src/web/frontend/src/components/ModeSwitch.vue';
import MessageList from '../../src/web/frontend/src/components/MessageList.vue';
import WorkspaceHome from '../../src/web/frontend/src/components/WorkspaceHome.vue';
import ToolGroup from '../../src/web/frontend/src/components/ToolGroup.vue';

describe('ModeSwitch', () => {
  it('defaults to chat active and emits goal when 任务模式 is clicked', async () => {
    const wrapper = mount(ModeSwitch, { props: { modelValue: 'chat' } });
    const pills = wrapper.findAll('.mode-pill');
    expect(pills.length).toBe(2);
    expect(pills[0]!.classes()).toContain('active');
    expect(pills[0]!.text()).toContain('智能工作');
    expect(pills[1]!.text()).toContain('任务模式');

    await pills[1]!.trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['goal']]);
  });

  it('renders the governed mode as active', () => {
    const wrapper = mount(ModeSwitch, { props: { modelValue: 'goal' } });
    expect(wrapper.findAll('.mode-pill')[1]!.classes()).toContain('active');
  });
});

describe('MessageList header grouping', () => {
  const base = { tools: [] };
  const messages = [
    { id: 'u1', role: 'user' as const, content: '问题一', ts: 1_000, ...base },
    { id: 'a1', role: 'assistant' as const, content: '回答一', ts: 2_000, model: 'deepseek-a', ...base },
    { id: 'a2', role: 'assistant' as const, content: '回答二', ts: 3_000, model: 'deepseek-b', ...base },
  ];

  it('shows the model name per assistant message and no avatar', () => {
    const wrapper = mount(MessageList, { props: { messages } });
    const models = wrapper.findAll('.brand-model').map((n) => n.text());
    expect(models).toEqual(['deepseek-a', 'deepseek-b']);
    expect(wrapper.find('.assistant-avatar').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Agent 回复');
  });

  it('only the last message of a consecutive assistant run shows its timestamp', () => {
    const wrapper = mount(MessageList, { props: { messages } });
    // The timestamp lives in the per-turn action row (bottom-right), not the
    // model header, so a run of assistant turns carries exactly one of them.
    const times = wrapper.findAll('.message-meta time.meta-time');
    expect(times.length).toBe(1);
    // User messages always keep their timestamp (they break the run).
    expect(wrapper.findAll('.user-meta .meta-time').length).toBe(1);
  });

  it('forces the timestamp back on after a >5 minute gap', () => {
    const spaced = [
      { ...messages[1]!, ts: 0 },
      { ...messages[2]!, ts: 6 * 60 * 1000 },
    ];
    const wrapper = mount(MessageList, { props: { messages: spaced } });
    expect(wrapper.findAll('.message-meta time.meta-time').length).toBe(2);
  });
});

describe('WorkspaceHome', () => {
  it('renders the prototype shell: brand, tagline, mode switch, model pill and placeholder', () => {
    const wrapper = mount(WorkspaceHome, {
      props: { models: [{ alias: 'a', provider: 'p', model: 'm', maxContextSize: 1000 }], status: { model: 'm' }, busy: false },
    });
        // The brand is the logo-v2 wordmark now, so "scream" lives in the image's
    // accessible name rather than in text nodes.
    const brand = wrapper.find('.workspace-brand');
    expect(brand.find('img.brand-logo').exists()).toBe(true);
    expect(brand.find('img.brand-logo').attributes('alt')).toBe('scream');
    expect(wrapper.find('.workspace-tagline').text()).toBe('你的智能协作伙伴');
    expect(wrapper.findAll('.mode-pill').length).toBe(2);
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).getAttribute('placeholder')).toContain('输入 @ 引用知识库');
    expect(wrapper.find('.model-select').text()).toContain('通用智能体');
    expect(wrapper.find('.send-btn').exists()).toBe(true);
  });

  it('emits send with the current mode when the composer sends', async () => {
    const wrapper = mount(WorkspaceHome, {
      props: { models: [], status: undefined, busy: false },
    });
    await wrapper.findAll('.mode-pill')[1]!.trigger('click');

    const ta = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    ta.value = '重构前端';
    await wrapper.find('.composer-input').trigger('input');
    await wrapper.find('.send-btn').trigger('click');

    expect(wrapper.emitted('send')).toEqual([['重构前端', 'goal']]);
  });
});

describe('ToolGroup fold status', () => {
  const pending = [{ toolCallId: 't1', name: 'Bash', args: { command: 'ls' } }];
  const finished = [{ toolCallId: 't1', name: 'Bash', args: { command: 'ls' }, output: 'a\nb' }];

  it('is collapsed by default and never auto-expands', () => {
    const wrapper = mount(ToolGroup, { props: { name: '工具调用过程', tools: pending, live: true } });
    expect(wrapper.find('.tool-process').classes()).not.toContain('open');
    expect(wrapper.find('.process-head').attributes('aria-expanded')).toBe('false');
  });

  it('reports 执行中 only while the turn is live', () => {
    const live = mount(ToolGroup, { props: { name: '工具调用过程', tools: pending, live: true } });
    expect(live.find('.process-dot').classes()).toContain('running');
    expect(live.find('.process-meta').text()).toContain('执行中');
  });

  it('settles a restored tool with no output as unknown, not running', () => {
    const restored = mount(ToolGroup, { props: { name: '工具调用过程', tools: pending, live: false } });
    expect(restored.find('.process-dot').classes()).toContain('unknown');
    expect(restored.find('.process-meta').text()).toContain('结果未持久化');
    expect(restored.find('.process-meta').text()).not.toContain('执行中');
  });

  it('counts completed calls when results are present', () => {
    const done = mount(ToolGroup, { props: { name: '工具调用过程', tools: finished, live: false } });
    expect(done.find('.process-dot').classes()).toContain('ok');
    expect(done.find('.process-meta').text()).toContain('已完成 1 项');
  });
});
