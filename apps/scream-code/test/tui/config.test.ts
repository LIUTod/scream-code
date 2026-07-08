import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TUI_CONFIG,
  loadTuiConfig,
  parseTuiConfig,
  saveTuiConfig,
  TuiConfigParseError,
} from '#/tui/config';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = join(tmpdir(), `scream-tui-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  filePath = join(dir, 'tui.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TUI config', () => {
  it('creates the default config when the file does not exist', async () => {
    const result = await loadTuiConfig(filePath);

    expect(result).toEqual(DEFAULT_TUI_CONFIG);
    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('Terminal UI preferences for scream-code.');
    expect(text).toContain('theme = "auto"');
    expect(text).toContain('command = ""');
    expect(text).toContain('[notifications]');
    expect(text).toContain('enabled = true');
    expect(text).toContain('notification_condition = "unfocused"');
  });

  it('parses valid TOML', () => {
    const config = parseTuiConfig(`
theme = "light"

[editor]
command = "code --wait"

[notifications]
enabled = false
notification_condition = "always"
`);

    expect(config).toEqual({
      theme: 'light',
      editorCommand: 'code --wait',
      notifications: { enabled: false, condition: 'always' },
      like: { nickname: undefined, tone: undefined, other: undefined },
      fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
      subagentModels: {},
      language: DEFAULT_TUI_CONFIG.language,
    });
  });

  it('normalizes an empty editor command to auto-detect', () => {
    const config = parseTuiConfig(`
[editor]
command = "   "
`);
    expect(config).toEqual({
      theme: 'auto',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      like: { nickname: undefined, tone: undefined, other: undefined },
      fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
      subagentModels: {},
      language: DEFAULT_TUI_CONFIG.language,
    });
  });

  it('falls back to default notifications when the section is omitted', () => {
    const config = parseTuiConfig(`theme = "dark"`);

    expect(config.notifications).toEqual({ enabled: true, condition: 'unfocused' });
  });

  it('throws TuiConfigParseError with fallback when parsing fails, leaving the file untouched', async () => {
    writeFileSync(filePath, '[[[', 'utf-8');

    const error = await loadTuiConfig(filePath).then(
      () => null,
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(TuiConfigParseError);
    expect((error as TuiConfigParseError).message).toBeTruthy();
    expect((error as TuiConfigParseError).fallback).toEqual(DEFAULT_TUI_CONFIG);
    expect(readFileSync(filePath, 'utf-8')).toBe('[[[');
  });

  it('saves and reloads the normalized config', async () => {
    await saveTuiConfig(
      {
        theme: 'light',
        language: 'zh',
        editorCommand: 'vim',
        notifications: { enabled: false, condition: 'always' },
        like: { nickname: undefined, tone: undefined, other: undefined },
        fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
        subagentModels: {},
      },
      filePath,
    );

    expect(await loadTuiConfig(filePath)).toEqual({
      theme: 'light',
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      like: { nickname: undefined, tone: undefined, other: undefined },
      fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
      subagentModels: {},
      language: 'zh',
    });
  });
});
