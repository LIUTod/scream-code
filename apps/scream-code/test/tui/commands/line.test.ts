import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUILTIN_SLASH_COMMANDS } from '#/tui/commands/registry';
import { isChannelTaken, mergeAndSaveConfig } from '#/tui/commands/line';
import { loadLineConfig, saveLineConfig, type LineConfig } from '#/line/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function useHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'line-wizard-'));
  homes.push(home);
  process.env['SCREAM_CODE_HOME'] = home;
  return home;
}

function fakeHost(): SlashCommandHost {
  return {
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    noteLineStateWrite: vi.fn(),
  } as unknown as SlashCommandHost;
}

const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const LINE_COMMAND_TS = join(REPO_ROOT, 'apps/scream-code/src/tui/commands/line.ts');
const ZH_TS = join(REPO_ROOT, 'packages/config/src/i18n/locale/zh.ts');
const EN_TS = join(REPO_ROOT, 'packages/config/src/i18n/locale/en.ts');

/** Every t('…') key referenced by the /line command. */
function lineCommandKeys(): string[] {
  const src = readFileSync(LINE_COMMAND_TS, 'utf8');
  return [...new Set([...src.matchAll(/\bt\('([a-z_.]+)'/g)].map((m) => m[1] as string))];
}

function localeHas(path: string, key: string): boolean {
  const src = readFileSync(path, 'utf8');
  return new RegExp(`'${key.replaceAll('.', '\\.')}'\\s*:`).test(src);
}

describe('single-channel invariant (/line wizard)', () => {
  const feishuOnly: LineConfig = {
    version: 1,
    feishu: { app_id: 'cli_a', app_secret: 's' },
    permissionMode: 'yolo',
    autoStart: true,
  };
  const weixinOnly: LineConfig = {
    version: 1,
    weixin: { token: 't' },
    permissionMode: 'yolo',
    autoStart: true,
  };

  it('blocks the weixin wizard while feishu is configured, and vice versa', () => {
    expect(isChannelTaken(feishuOnly, 'weixin')).toBe(true);
    expect(isChannelTaken(feishuOnly, 'feishu')).toBe(false);
    expect(isChannelTaken(weixinOnly, 'feishu')).toBe(true);
    expect(isChannelTaken(weixinOnly, 'weixin')).toBe(false);
  });

  it('allows everything on a fresh (unconfigured) channel', () => {
    expect(isChannelTaken(null, 'feishu')).toBe(false);
    expect(isChannelTaken(null, 'weixin')).toBe(false);
  });
});

describe('/line registration and i18n completeness', () => {
  it('is registered in the TUI command registry', () => {
    const entry = BUILTIN_SLASH_COMMANDS.find((c) => c.name === 'line');
    expect(entry).toBeDefined();
    expect(entry?.availability).toBe('always');
    expect(entry?.description).toBe('registry.line_desc');
  });

  it('every key used by the command exists in both locales', () => {
    const missing: string[] = [];
    for (const key of lineCommandKeys()) {
      if (!localeHas(ZH_TS, key)) missing.push(`zh:${key}`);
      if (!localeHas(EN_TS, key)) missing.push(`en:${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('declares the registry description in both locales', () => {
    expect(localeHas(ZH_TS, 'registry.line_desc')).toBe(true);
    expect(localeHas(EN_TS, 'registry.line_desc')).toBe(true);
  });

  it('the zh tutorial mentions the long-connection step (no public IP needed)', () => {
    const zh = readFileSync(ZH_TS, 'utf8');
    expect(zh).toContain('使用长连接接收事件');
    expect(zh).toContain('无需公网 IP');
  });
});

describe('wizard merge and defaults', () => {
  it('gives a fresh config the IM default permission (auto)', async () => {
    useHome();
    const ok = await mergeAndSaveConfig(fakeHost(), {
      feishu: { app_id: 'cli_a', app_secret: 'secret' } as never,
    });
    expect(ok).toBe(true);
    const loaded = await loadLineConfig();
    expect(loaded?.permissionMode).toBe('auto');
  });

  it('keeps an explicit permission mode and the custom commands it did not touch', async () => {
    useHome();
    await saveLineConfig({
      version: 1,
      feishu: { app_id: 'old', app_secret: 'old' },
      permissionMode: 'yolo',
      autoStart: false,
      commands: [{ name: '/standup', prompt: '总结：{args}' }],
    } as never);

    const ok = await mergeAndSaveConfig(fakeHost(), {
      feishu: { app_id: 'new', app_secret: 'new' } as never,
    });
    expect(ok).toBe(true);

    const loaded = await loadLineConfig();
    expect(loaded?.permissionMode).toBe('yolo');
    expect(loaded?.autoStart).toBe(false);
    // Rebuilding the object must not silently delete the command registry.
    expect(loaded?.commands).toEqual([{ name: '/standup', prompt: '总结：{args}' }]);
    expect(loaded?.feishu?.app_id).toBe('new');
  });
});
