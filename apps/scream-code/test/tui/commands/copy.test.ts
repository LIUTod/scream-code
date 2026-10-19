/**
 * copy.test.ts — `/copy` 行为契约。
 *
 * 只复制"最后一条非空 assistant 回复"：工具输出与通知不算回复，被取消的
 * 空回合也不算。剪贴板失败必须显式报错（用户要的是副作用，不能假装成功）。
 */
import { describe, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => ({ writeTextClipboard: vi.fn(async (_text: string) => undefined) }));
vi.mock('#/utils/clipboard/clipboard-text', () => clipboard);

import { t } from '@scream-code/config';

import { handleCopyCommand } from '#/tui/commands/copy';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

interface Entry {
  kind: string;
  content: string;
}

function makeHost(entries: Entry[]): {
  host: SlashCommandHost;
  showStatus: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
} {
  const showStatus = vi.fn();
  const showError = vi.fn();
  const host = {
    state: { transcriptEntries: entries },
    showStatus,
    showError,
  } as unknown as SlashCommandHost;
  return { host, showStatus, showError };
}

describe('/copy', () => {
  it('复制最后一条非空 assistant 回复（跳过工具输出与空回复）', async () => {
    clipboard.writeTextClipboard.mockClear();
    const { host, showStatus, showError } = makeHost([
      { kind: 'user', content: 'first question' },
      { kind: 'assistant', content: 'first answer' },
      { kind: 'tool', content: 'tool output' },
      { kind: 'assistant', content: '   ' },
      { kind: 'assistant', content: 'latest answer' },
      { kind: 'notice', content: 'a notice' },
    ]);

    await handleCopyCommand(host);

    expect(clipboard.writeTextClipboard).toHaveBeenCalledWith('latest answer');
    expect(showStatus).toHaveBeenCalledWith(t('tui.copy_done'));
    expect(showError).not.toHaveBeenCalled();
  });

  it('没有可复制的回复 → 只提示，不调用剪贴板', async () => {
    clipboard.writeTextClipboard.mockClear();
    const { host, showStatus } = makeHost([
      { kind: 'user', content: 'question only' },
      { kind: 'tool', content: 'output' },
    ]);

    await handleCopyCommand(host);

    expect(clipboard.writeTextClipboard).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith(t('tui.copy_empty'));
  });

  it('末尾只有空白 assistant 条目 → 回落复制上一条非空回复', async () => {
    clipboard.writeTextClipboard.mockClear();
    const { host } = makeHost([
      { kind: 'assistant', content: 'earlier answer' },
      { kind: 'assistant', content: '   ' },
    ]);

    await handleCopyCommand(host);

    expect(clipboard.writeTextClipboard).toHaveBeenCalledWith('earlier answer');
  });

  it('仅空白回复 → 不复制、提示空', async () => {
    clipboard.writeTextClipboard.mockClear();
    const { host, showStatus } = makeHost([
      { kind: 'assistant', content: '  \n ' },
    ]);

    await handleCopyCommand(host);

    expect(clipboard.writeTextClipboard).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith(t('tui.copy_empty'));
  });

  it('剪贴板写入失败 → 报错而不是假装成功', async () => {
    clipboard.writeTextClipboard.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const { host, showStatus, showError } = makeHost([
      { kind: 'assistant', content: 'answer' },
    ]);

    await handleCopyCommand(host);

    expect(showError).toHaveBeenCalledWith(
      t('tui.copy_failed', { msg: 'clipboard unavailable' }),
    );
    expect(showStatus).not.toHaveBeenCalled();
  });
});
