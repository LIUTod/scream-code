/**
 * config-entry.test.ts — `/config` 入口分流菜单。
 *
 * 行为契约：
 * - 空参与未知参数 → 挂载三选一菜单（快捷 / 自定义 / 生图），此时不触发任何流程
 * - 选中项 → 进入对应既有流程（本测试把三条流程都"停在第一步"观测）
 * - Esc → 交还编辑器、零副作用
 * - `/config diy`、`/config image` → 直通，不经过菜单
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 目录流程停在可观测的第一步：远端必失败 + 缓存/内置都缺席 → showError 后返回。
const sdkState = vi.hoisted(() => ({ fetchCatalogCalls: 0 }));
vi.mock('@scream-code/scream-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@scream-code/scream-code-sdk')>();
  return {
    ...actual,
    fetchCatalog: vi.fn(async () => {
      sdkState.fetchCatalogCalls += 1;
      throw new Error('network down (test)');
    }),
    loadCatalogCache: vi.fn(() => undefined),
    loadBuiltInCatalog: vi.fn(() => undefined),
    saveCatalogCache: vi.fn(),
  };
});

// DIY 首步打桩：记录被调用即算"已进入 DIY 流程"，返回 undefined 立即退出。
const promptsState = vi.hoisted(() => ({ wireCalls: 0 }));
vi.mock('#/tui/commands/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/tui/commands/prompts')>();
  return {
    ...actual,
    promptWireType: vi.fn(async () => {
      promptsState.wireCalls += 1;
      return undefined;
    }),
  };
});

import { t } from '@scream-code/config';

import { handleConnectCommand } from '#/tui/commands/auth';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { darkColors } from '#/tui/theme/colors';

const ESC = '\u001B';
const DOWN = '\u001B[B';
const ENTER = '\r';
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

interface MountedPanel {
  render(width: number): string[];
}

function makeHost(): {
  host: SlashCommandHost;
  mounted: MountedPanel[];
  restoreEditor: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
} {
  const mounted: MountedPanel[] = [];
  const restoreEditor = vi.fn();
  const showError = vi.fn();
  const host = {
    session: undefined,
    state: { theme: { colors: darkColors } },
    cancelInFlight: undefined,
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mounted.push(panel);
    }),
    restoreEditor,
    showProgressSpinner: vi.fn(() => ({ setLabel: vi.fn(), stop: vi.fn() })),
    showError,
    showStatus: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, mounted, restoreEditor, showError };
}

function panelText(panel: MountedPanel): string {
  return panel.render(120).join('\n').replaceAll(ANSI_SGR, '');
}

/** 让 fire-and-forget 的流程推进过若干微任务/宏任务（含 fs 读取等异步步骤）。 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('/config 入口菜单', () => {
  // 计数器是模块级 hoisted 状态：每个用例都必须从零开始，否则前一个用例的
  // 调用会污染后一个用例的"未触发"断言。
  beforeEach(() => {
    sdkState.fetchCatalogCalls = 0;
    promptsState.wireCalls = 0;
  });

  it('空参 → 挂载三选一菜单（含三项文案与提示），此时不触发任何流程', async () => {
    const { host, mounted } = makeHost();
    sdkState.fetchCatalogCalls = 0;
    promptsState.wireCalls = 0;

    void handleConnectCommand(host, '');
    await flush();

    expect(mounted).toHaveLength(1);
    const text = panelText(mounted[0]!);
    expect(text).toContain(t('config.entry_title'));
    expect(text).toContain(t('config.entry_quick'));
    expect(text).toContain(t('config.entry_diy'));
    expect(text).toContain(t('config.entry_image'));
    expect(text).toContain(t('config.entry_hint'));
    expect(sdkState.fetchCatalogCalls).toBe(0);
    expect(promptsState.wireCalls).toBe(0);
  });

  it('未知参数同样进菜单（静默，不报错）', async () => {
    const { host, mounted } = makeHost();

    void handleConnectCommand(host, 'foo');
    await flush();

    expect(mounted).toHaveLength(1);
    expect(panelText(mounted[0]!)).toContain(t('config.entry_title'));
  });

  it('选①快捷 → 进入目录流程（fetchCatalog 被调用）', async () => {
    const { host, mounted, restoreEditor } = makeHost();
    sdkState.fetchCatalogCalls = 0;

    void handleConnectCommand(host, '');
    await flush();
    (mounted[0] as unknown as { handleInput(data: string): void }).handleInput(ENTER);
    await flush();

    expect(restoreEditor).toHaveBeenCalled();
    expect(sdkState.fetchCatalogCalls).toBe(1);
    expect(promptsState.wireCalls).toBe(0);
  });

  it('选②自定义Diy → 进入 DIY 流程首步（promptWireType 被调用）', async () => {
    const { host, mounted, restoreEditor } = makeHost();
    promptsState.wireCalls = 0;

    void handleConnectCommand(host, '');
    await flush();
    const picker = mounted[0] as unknown as { handleInput(data: string): void };
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);
    await flush();

    expect(restoreEditor).toHaveBeenCalled();
    expect(promptsState.wireCalls).toBe(1);
    expect(sdkState.fetchCatalogCalls).toBe(0);
  });

  it('选③生图 → 进入生图配置流程（挂载生图预设面板，不回目录流程）', async () => {
    const { host, mounted } = makeHost();
    sdkState.fetchCatalogCalls = 0;

    void handleConnectCommand(host, '');
    await flush();
    const picker = mounted[0] as unknown as { handleInput(data: string): void };
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);
    await flush();

    expect(mounted).toHaveLength(2);
    expect(panelText(mounted[1]!)).toContain(t('image.provider_title'));
    expect(sdkState.fetchCatalogCalls).toBe(0);
  });

  it('Esc → 交还编辑器，三条流程均未触发', async () => {
    const { host, mounted, restoreEditor, showError } = makeHost();
    sdkState.fetchCatalogCalls = 0;
    promptsState.wireCalls = 0;

    void handleConnectCommand(host, '');
    await flush();
    (mounted[0] as unknown as { handleInput(data: string): void }).handleInput(ESC);
    await flush();

    expect(restoreEditor).toHaveBeenCalledTimes(1);
    expect(sdkState.fetchCatalogCalls).toBe(0);
    expect(promptsState.wireCalls).toBe(0);
    expect(mounted).toHaveLength(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('/config diy 直通 DIY：不挂菜单面板', async () => {
    const { host, mounted } = makeHost();
    promptsState.wireCalls = 0;

    await handleConnectCommand(host, 'diy');

    expect(promptsState.wireCalls).toBe(1);
    expect(mounted).toHaveLength(0);
  });

  it('/config image 直通生图：唯一挂载的是生图面板，不是菜单', async () => {
    const { host, mounted } = makeHost();

    void handleConnectCommand(host, 'image');
    await flush();

    expect(mounted).toHaveLength(1);
    const text = panelText(mounted[0]!);
    expect(text).toContain(t('image.provider_title'));
    expect(text).not.toContain(t('config.entry_title'));
  });
});
