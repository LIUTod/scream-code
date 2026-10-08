import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { showModelPicker } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { darkColors } from '#/tui/theme/colors';

let home: string;
let originalHome: string | undefined;

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeHost(): SlashCommandHost {
  return {
    state: {
      appState: {
        workDir: '/tmp',
        model: 'p/alpha',
        thinkingLevel: 'high',
        availableModels: {
          'p/alpha': { provider: 'p', model: 'alpha', maxContextSize: 1000 },
        },
      },
      theme: { colors: darkColors },
    },
    showError: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
}

function panelText(host: SlashCommandHost): string {
  const calls = (host.mountEditorReplacement as Mock).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const panel = calls.at(-1)![0] as { render: (w: number) => string[] };
  return panel
    .render(80)
    .map(stripAnsi)
    .join('\n');
}

beforeEach(async () => {
  originalHome = process.env['SCREAM_CODE_HOME'];
  home = await mkdtemp(join(tmpdir(), 'scream-model-picker-'));
  process.env['SCREAM_CODE_HOME'] = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe('showModelPicker — image-generation status wiring', () => {
  it('passes the configured image model through to the picker', async () => {
    await writeFile(
      join(home, 'image-config.json'),
      JSON.stringify({
        url: 'https://gateway.test/v1/images/generations',
        api_key: 'sk-real-key',
        model: 'gpt-image-2',
      }),
      'utf8',
    );
    const host = makeHost();
    await showModelPicker(host);
    expect(panelText(host)).toContain('生图模型：gpt-image-2 · 已配置');
  });

  it('passes the unconfigured state when no image config exists', async () => {
    const host = makeHost();
    await showModelPicker(host);
    expect(panelText(host)).toContain('生图模型：未配置');
  });
});
