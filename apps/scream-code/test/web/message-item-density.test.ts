// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import MessageItem from '../../src/web/frontend/src/components/MessageItem.vue';
import { filePanel } from '../../src/web/frontend/src/utils/fileTabState';
import type { ChatMessage } from '../../src/web/frontend/src/types';

const WORK_DIR = '/Users/dev/project';

function assistantWithWrites(): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'done',
    model: 'test-model',
    ts: 1_000,
    tools: [
      { toolCallId: 't1', name: 'Write', args: { path: 'src/a.ts', content: 'x' }, output: 'ok' },
      { toolCallId: 't2', name: 'Edit', args: { path: 'src/b.ts', old_string: 'a', new_string: 'b' }, output: 'ok' },
      { toolCallId: 't3', name: 'Write', args: { path: 'src/a.ts', content: 'y' }, output: 'ok' }, // dup
      { toolCallId: 't4', name: 'Write', args: { path: 'src/fail.ts' }, output: 'boom', isError: true },
    ],
  };
}

describe('MessageItem role headers', () => {
  it('renders the user head with avatar, name and the timestamp', () => {
    const msg: ChatMessage = { id: 'u1', role: 'user', content: '你好', ts: 1_000, tools: [] };
    const wrapper = mount(MessageItem, { props: { message: msg } });
    const head = wrapper.find('.user-head');
    expect(head.exists()).toBe(true);
    expect(head.find('.user-avatar').exists()).toBe(true);
    expect(head.find('.head-name').text()).toBe('你');
    expect(head.find('.meta-time').exists()).toBe(true);
    // No duplicate timestamp below the bubble.
    expect(wrapper.find('.user-meta .meta-time').exists()).toBe(false);
  });

  it('renders the assistant head with model name and timestamp, and no time in the action row', () => {
    const wrapper = mount(MessageItem, { props: { message: assistantWithWrites() } });
    const brand = wrapper.find('.assistant-brand');
    expect(brand.find('.brand-model').text()).toBe('test-model');
    expect(brand.find('time.brand-time').exists()).toBe(true);
    expect(wrapper.find('.message-meta time.meta-time').exists()).toBe(false);
  });
});

describe('MessageItem turn written-files pills', () => {
  it('lists deduped successful writes as pills and hides pending/failed ones', () => {
    const wrapper = mount(MessageItem, {
      props: { message: assistantWithWrites(), workDir: WORK_DIR },
    });
    const pills = wrapper.findAll('.written-file');
    expect(pills.map((p) => p.text())).toEqual(['a.ts', 'b.ts']);
    expect(pills[0]!.attributes('title')).toBe(`在文件面板中打开 ${WORK_DIR}/src/a.ts`);
  });

  it('opens the file panel at the resolved path on click', async () => {
    filePanel.tabs = [];
    filePanel.panelOpen = false;
    const wrapper = mount(MessageItem, {
      props: { message: assistantWithWrites(), workDir: WORK_DIR },
    });
    await wrapper.findAll('.written-file')[0]!.trigger('click');
    expect(filePanel.panelOpen).toBe(true);
    expect(filePanel.tabs.map((t) => t.filePath)).toEqual([`${WORK_DIR}/src/a.ts`]);
  });

  it('renders nothing while the turn is still streaming', () => {
    const wrapper = mount(MessageItem, {
      props: { message: assistantWithWrites(), workDir: WORK_DIR, streaming: true },
    });
    expect(wrapper.find('.written-files').exists()).toBe(false);
  });
});

describe('MessageItem @ file-mention links', () => {
  it('links only @ segments and resolves them against workDir', async () => {
    const msg: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: '看下 @src/a.ts 和 @"my dir/note.md" 再说 /etc/hosts 的事',
      ts: 2_000,
      tools: [],
    };
    filePanel.tabs = [];
    filePanel.panelOpen = false;
    const wrapper = mount(MessageItem, { props: { message: msg, workDir: WORK_DIR } });
    const links = wrapper.findAll('.at-link');
    expect(links.map((l) => l.text())).toEqual(['@src/a.ts', '@"my dir/note.md"']);
    expect(links[0]!.attributes('title')).toBe(`在文件面板中打开 ${WORK_DIR}/src/a.ts`);

    await links[1]!.trigger('click');
    expect(filePanel.tabs.map((t) => t.filePath)).toEqual([`${WORK_DIR}/my dir/note.md`]);
  });

  it('keeps plain prose without @ untouched', () => {
    const msg: ChatMessage = {
      id: 'u3',
      role: 'user',
      content: '散文里提到 src/a.ts 不该变成链接',
      ts: 3_000,
      tools: [],
    };
    const wrapper = mount(MessageItem, { props: { message: msg, workDir: WORK_DIR } });
    expect(wrapper.findAll('.at-link')).toEqual([]);
    expect(wrapper.find('.user-bubble').text()).toBe(msg.content);
  });
});
