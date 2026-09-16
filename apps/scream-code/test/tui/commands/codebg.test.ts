/**
 * codebg.test.ts — /codebg 命令的行为测试。
 *
 * 偏好读写走真实模块：测试环境的数据目录是临时目录（见 test/global-setup.ts），
 * 所以这里可以断言真实的持久化结果，而不会碰到用户的配置。
 */

import { t } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCodeBgCommand } from '#/tui/commands/codebg';
import { darkColors } from '#/tui/theme/colors';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { isCodeBlockPanelEnabled, toggleCodeBlockPanel } from '#/tui/utils/ui-preferences';

function makeHost(): { host: SlashCommandHost; invalidate: ReturnType<typeof vi.fn> } {
  const invalidate = vi.fn();
  const host = {
    state: {
      theme: { colors: darkColors },
      transcriptContainer: { children: [{ invalidate }] },
      ui: { requestRender: vi.fn() },
    },
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, invalidate };
}

describe('handleCodeBgCommand', () => {
  beforeEach(() => {
    // Start every case with the panel on, whatever the previous case left behind.
    if (!isCodeBlockPanelEnabled()) toggleCodeBlockPanel();
  });

  afterEach(() => {
    if (!isCodeBlockPanelEnabled()) toggleCodeBlockPanel();
  });

  it('turns the panel off, reports it and repaints what is already on screen', async () => {
    const { host, invalidate } = makeHost();

    await handleCodeBgCommand(host, '');

    expect(isCodeBlockPanelEnabled()).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith(t('codebg.disabled'), darkColors.textDim);
    // Code blocks cache their rows, so the toggle has to invalidate them.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(host.state.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it('turns it back on', async () => {
    const { host } = makeHost();

    await handleCodeBgCommand(host, '');
    await handleCodeBgCommand(host, '');

    expect(isCodeBlockPanelEnabled()).toBe(true);
    expect(host.showStatus).toHaveBeenLastCalledWith(t('codebg.enabled'), darkColors.success);
  });
});
