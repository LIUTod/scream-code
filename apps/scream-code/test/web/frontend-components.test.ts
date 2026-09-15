// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ModeSwitch from '../../src/web/frontend/src/components/ModeSwitch.vue';
import MessageList from '../../src/web/frontend/src/components/MessageList.vue';
import WorkspaceHome from '../../src/web/frontend/src/components/WorkspaceHome.vue';
import ToolGroup from '../../src/web/frontend/src/components/ToolGroup.vue';

describe('ModeSwitch', () => {
  it('defaults to chat active and emits goal when the goal mode pill is clicked', async () => {
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
    // Timestamps moved into the role header rows: the assistant one sits next
    // to the model name, so a run of assistant turns carries exactly one.
    const times = wrapper.findAll('.assistant-brand time.brand-time');
    expect(times.length).toBe(1);
    // User messages always keep their timestamp (they break the run) — now in
    // the user header row.
    expect(wrapper.findAll('.user-head .meta-time').length).toBe(1);
  });

  it('forces the timestamp back on after a >5 minute gap', () => {
    const spaced = [
      { ...messages[1]!, ts: 0 },
      { ...messages[2]!, ts: 6 * 60 * 1000 },
    ];
    const wrapper = mount(MessageList, { props: { messages: spaced } });
    expect(wrapper.findAll('.assistant-brand time.brand-time').length).toBe(2);
  });
});

describe('ToolGroup long-run pagination', () => {
  // Field case: one turn of a real session issued 97 tool calls and, even collapsed,
  // all 97 cards were rendered into the DOM (reported as "98 tool steps laid out flat,
  // impossible to read").
  function manyTools(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      toolCallId: `t${i}`,
      name: 'FetchURL',
      args: { url: `https://example.com/${i}` },
      output: 'ok',
      ...(i === 3 ? { isError: true } : {}),
    }));
  }

  it('renders only the first 20 of 97 by default, keeps the failure summary, and renders everything only after "show all"', async () => {
    const wrapper = mount(ToolGroup, {
      props: { name: '工具调用过程', tools: manyTools(97), live: false },
    });

    // 1. DOM cap: 20 by default, not 97.
    expect(wrapper.findAll('.tool-card').length).toBe(20);
    // 2. A failed call stays visible at a glance (the summary line is unchanged).
    const meta = wrapper.find('.process-meta').text();
    expect(meta).toContain('含失败调用');
    expect(meta).toContain('97 步');
    // 3. The collapsed state renders no entry button: a button inside the 0fr container
    // would be a ghost tab stop.
    expect(wrapper.find('.process-more-btn').exists()).toBe(false);

    // Expanding the group reveals the "77 more" entry point.
    await wrapper.find('.process-head').trigger('click');
    const more = wrapper.find('.process-more-btn');
    expect(more.text()).toContain('还有 77 条');
    expect(more.attributes('aria-expanded')).toBe('false');

    await more.trigger('click');
    expect(wrapper.findAll('.tool-card').length).toBe(97);
    expect(wrapper.find('.process-more-btn').text()).toContain('收起');
    expect(wrapper.find('.process-more-btn').attributes('aria-expanded')).toBe('true');

    // Clicking once more returns to 20: the cap is not permanently raised by expanding once.
    await wrapper.find('.process-more-btn').trigger('click');
    expect(wrapper.findAll('.tool-card').length).toBe(20);
    expect(wrapper.find('.process-more-btn').text()).toContain('还有 77 条');
  });

  it('shows no entry point at all for a short list (20 or fewer), matching the behaviour before the change', async () => {
    const wrapper = mount(ToolGroup, {
      props: { name: '工具调用过程', tools: manyTools(16), live: false },
    });
    await wrapper.find('.process-head').trigger('click');
    expect(wrapper.findAll('.tool-card').length).toBe(16);
    expect(wrapper.find('.process-more-btn').exists()).toBe(false);
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
    // L2 single primary button: three states collapse into .composer-primary, and the idle state carries data-action="send".
    expect(wrapper.find('.composer-primary[data-action="send"]').exists()).toBe(true);
  });

  it('emits send with the current mode when the composer sends', async () => {
    const wrapper = mount(WorkspaceHome, {
      props: { models: [], status: undefined, busy: false },
    });
    await wrapper.findAll('.mode-pill')[1]!.trigger('click');
    // The shell owns the mode; the home view only reports the intent.
    expect(wrapper.emitted('update:mode')).toEqual([['goal']]);
    await wrapper.setProps({ mode: 'goal' });

    const ta = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    ta.value = '重构前端';
    await wrapper.find('.composer-input').trigger('input');
    await wrapper.find('.composer-primary[data-action="send"]').trigger('click');

    expect(wrapper.emitted('send')).toEqual([['重构前端', 'goal']]);
  });

  it('shows connection and model status as small type with a color dot', () => {
    const connected = mount(WorkspaceHome, {
      props: { models: [], status: { busy: false, model: 'm' }, busy: false },
    });
    expect(connected.find('.workspace-status .status-dot').classes()).toContain('on');
    expect(connected.find('.workspace-status').text()).toContain('已连接');
    expect(connected.find('.workspace-status').text()).toContain('m');

    const pending = mount(WorkspaceHome, {
      props: { models: [], status: undefined, busy: false },
    });
    expect(pending.find('.workspace-status .status-dot').classes()).toContain('off');
    expect(pending.find('.workspace-status').text()).toContain('等待连接');
    expect(pending.find('.workspace-status').text()).not.toContain('模型');
  });

  it('falls back to starter chips and fills the composer when one is picked', async () => {
    localStorage.removeItem('scream-recent-prompts');
    const wrapper = mount(WorkspaceHome, {
      props: { models: [], status: undefined, busy: false },
    });
    const chips = wrapper.findAll('.quick-chip');
    expect(chips.length).toBe(3);
    expect(wrapper.find('.quick-label').text()).toBe('试试');

    await chips[0]!.trigger('click');
    const ta = wrapper.find('.composer-input').element as HTMLTextAreaElement;
    expect(ta.value).toBe(chips[0]!.text());
  });

  it('shows recent prompts from localStorage as quick chips when present', async () => {
    localStorage.setItem('scream-recent-prompts', JSON.stringify(['fix the build']));
    const wrapper = mount(WorkspaceHome, {
      props: { models: [], status: undefined, busy: false },
    });
    await wrapper.vm.$nextTick();
    const chips = wrapper.findAll('.quick-chip').map((n) => n.text());
    expect(chips).toContain('fix the build');
    expect(wrapper.find('.quick-label').text()).toBe('最近');
    localStorage.removeItem('scream-recent-prompts');
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

  it('reports the running label only while the turn is live', () => {
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
