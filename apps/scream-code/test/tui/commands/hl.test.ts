/**
 * hl.test.ts — `/hl` 的行为与默认值。
 *
 * 偏好读写走真实模块（测试环境的数据目录是临时目录，见 test/global-setup.ts），
 * 所以这里断言的是真实的持久化结果。
 *
 * 重点钉两件事：
 *   1. 装完没动过 `/hl` 的用户 = 显示淡底色（默认开启）；
 *   2. 第一次 `/hl` 必须把它**关闭** —— 读默认值与写默认值必须是同一个默认值，
 *      否则会出现「按了没反应」：读到 true、写入 true、屏幕上什么都不变。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { t } from '@scream-code/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleHighlightCommand } from '#/tui/commands/hl';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { darkColors } from '#/tui/theme/colors';
import {
  getUiPreferencesPath,
  isUserMessageHighlightEnabled,
  toggleUserMessageHighlight,
} from '#/tui/utils/ui-preferences';

function makeHost(): { host: SlashCommandHost } {
  const host = {
    state: {
      theme: { colors: darkColors },
      ui: { requestRender: vi.fn() },
    },
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host };
}

/**
 * Drop only our key, leaving every other preference intact — other test files
 * share this file and write their own keys into it.
 */
function clearHighlightPreference(): void {
  const path = getUiPreferencesPath();
  if (!existsSync(path)) return;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete parsed['userMessageHighlightEnabled'];
  writeFileSync(path, JSON.stringify(parsed));
}

describe('/hl', () => {
  beforeEach(clearHighlightPreference);
  afterEach(clearHighlightPreference);

  it('defaults to on for an install that never touched it', () => {
    expect(isUserMessageHighlightEnabled()).toBe(true);
  });

  it('turns the band off with the first /hl, and reports it', async () => {
    const { host } = makeHost();

    await handleHighlightCommand(host, '');

    expect(isUserMessageHighlightEnabled()).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith(t('hl.disabled'), darkColors.textDim);
    // Already-rendered messages cache their rows, so the toggle repaints.
    expect(host.state.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it('toggles back on and reports that too', async () => {
    const { host } = makeHost();

    await handleHighlightCommand(host, '');
    await handleHighlightCommand(host, '');

    expect(isUserMessageHighlightEnabled()).toBe(true);
    expect(host.showStatus).toHaveBeenLastCalledWith(t('hl.enabled'), darkColors.success);
  });

  it('persists an explicit choice, so a restart keeps it', () => {
    expect(toggleUserMessageHighlight()).toBe(false);
    expect(isUserMessageHighlightEnabled()).toBe(false);

    expect(toggleUserMessageHighlight()).toBe(true);
    expect(isUserMessageHighlightEnabled()).toBe(true);
  });
});
