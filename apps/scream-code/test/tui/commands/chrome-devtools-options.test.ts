import { describe, expect, it } from 'vitest';

import {
  browserOptionFlags,
  buildBrowserArgs,
  CHROME_DEVTOOLS_BASE_FLAGS,
  CHROME_DEVTOOLS_PACKAGE,
  cycleChannel,
  cycleViewport,
  DEFAULT_BROWSER_OPTIONS,
  installedPackageSpec,
  launchOptionBlocker,
  parseBrowserOptions,
  unmanagedArgs,
  VIEWPORT_PRESETS,
} from '#/tui/commands/chrome-devtools-options';

describe('chrome-devtools 启动参数：构建', () => {
  it('默认选项不产生任何选项 flag（推荐值保持最小）', () => {
    const args = buildBrowserArgs(DEFAULT_BROWSER_OPTIONS);

    expect(args.slice(0, 2)).toEqual(['-y', CHROME_DEVTOOLS_PACKAGE]);
    expect(args.slice(2)).toEqual([...CHROME_DEVTOOLS_BASE_FLAGS]);
    expect(browserOptionFlags(DEFAULT_BROWSER_OPTIONS)).toEqual([]);
    // 产品自有 flag 必须在默认值里，否则新装就拿不到隐私/体积默认项。
    expect(args).toContain('--redact-network-headers');
    expect(args).toContain('--no-file-navigations');
    expect(args).toContain('--category-network-mocks');
    expect(args).toContain('--memory-debugging');
  });

  it('选项按固定顺序追加在自有 flag 之后', () => {
    const args = buildBrowserArgs({
      headless: true,
      isolated: true,
      viewport: '1280x800',
      autoConnect: false,
      channel: 'beta',
    });

    expect(args.slice(-4)).toEqual([
      '--headless',
      '--isolated',
      '--viewport=1280x800',
      '--channel=beta',
    ]);
    expect(args.indexOf('--headless')).toBeGreaterThan(args.indexOf('--memory-debugging'));
  });
});

describe('chrome-devtools 启动参数：解析（手改过的配置也要读得回来）', () => {
  it('构建 → 解析 round-trip 保持一致', () => {
    const options = {
      headless: true,
      isolated: false,
      viewport: '1440x900',
      autoConnect: false,
      channel: 'canary' as const,
    };

    expect(parseBrowserOptions(buildBrowserArgs(options))).toEqual(options);
  });

  it('同时接受 camelCase 与 `--flag value` 写法', () => {
    const parsed = parseBrowserOptions([
      '--autoConnect',
      '--viewport',
      '1920x1200',
      '--channel',
      'dev',
    ]);

    expect(parsed.autoConnect).toBe(true);
    expect(parsed.viewport).toBe('1920x1200');
    expect(parsed.channel).toBe('dev');
  });

  it('值缺失或非法时退回默认，不吞掉后面的 flag', () => {
    const parsed = parseBrowserOptions([
      '--viewport',
      '--headless',
      '--channel=nonsense',
    ]);

    // `--viewport` 后面紧跟 flag 说明值被漏写：不要把它当视口值吃掉。
    expect(parsed.viewport).toBeUndefined();
    expect(parsed.headless).toBe(true);
    expect(parsed.channel).toBe('stable');
  });

  it('空数组 / 无关参数 → 全默认', () => {
    expect(parseBrowserOptions([])).toEqual(DEFAULT_BROWSER_OPTIONS);
    expect(parseBrowserOptions(['-y', 'chrome-devtools-mcp@1.13.0', '--no-usage-statistics'])).toEqual(
      DEFAULT_BROWSER_OPTIONS,
    );
  });
});

describe('chrome-devtools 启动参数：布尔 flag 的各种写法', () => {
  const BASE = ['-y', 'chrome-devtools-mcp@latest'];

  /** 菜单里切换任意选项后保存会走的路径：解析 → 重新构建，自定义 flag 原样带上。 */
  function resave(args: readonly string[]): string[] {
    return buildBrowserArgs(parseBrowserOptions(args), {
      packageSpec: installedPackageSpec(args),
      keep: unmanagedArgs(args),
    });
  }

  it.each([
    ['--headless', true],
    ['--headless=true', true],
    ['--headless=TRUE', true],
    ['--headless=false', false],
    ['--no-headless', false],
  ])('headless 写成 %s → %s', (flag, expected) => {
    expect(parseBrowserOptions([...BASE, flag]).headless).toBe(expected);
  });

  it('接受 `--flag true|false` 写法，且只吞掉这个布尔词', () => {
    expect(parseBrowserOptions([...BASE, '--headless', 'true']).headless).toBe(true);
    expect(parseBrowserOptions([...BASE, '--headless', 'false']).headless).toBe(false);
    // 后面跟的是别的 flag：不吞
    expect(parseBrowserOptions([...BASE, '--headless', '--isolated']).isolated).toBe(true);
  });

  it('isolated 与 auto-connect（含 camelCase）同样支持 =true / --no-', () => {
    expect(parseBrowserOptions([...BASE, '--isolated=true']).isolated).toBe(true);
    expect(parseBrowserOptions([...BASE, '--no-isolated']).isolated).toBe(false);
    expect(parseBrowserOptions([...BASE, '--auto-connect=true']).autoConnect).toBe(true);
    expect(parseBrowserOptions([...BASE, '--autoConnect=true']).autoConnect).toBe(true);
    expect(parseBrowserOptions([...BASE, '--no-autoConnect']).autoConnect).toBe(false);
  });

  it('同一个 flag 出现多次时以最后一个为准（和 yargs 一致）', () => {
    expect(parseBrowserOptions([...BASE, '--headless', '--no-headless']).headless).toBe(false);
    expect(parseBrowserOptions([...BASE, '--no-headless', '--headless=true']).headless).toBe(true);
  });

  it('值不是布尔时退回默认，但不把它当成用户自己的 flag 留下', () => {
    const args = [...BASE, '--headless=maybe', '--browserUrl', 'http://127.0.0.1:9222'];
    expect(parseBrowserOptions(args).headless).toBe(false);
    expect(unmanagedArgs(args)).toEqual(['--browserUrl', 'http://127.0.0.1:9222']);
  });

  it('保存时不丢手写的 =true（回归：此前切换任意选项都会静默丢掉）', () => {
    expect(resave([...BASE, '--headless=true'])).toContain('--headless');
    expect(resave([...BASE, '--isolated=true'])).toContain('--isolated');
    expect(resave([...BASE, '--autoConnect=true'])).toContain('--auto-connect');
  });

  it('保存时 --no-headless 不会作为多余 flag 残留，与菜单写出的值打架', () => {
    const saved = resave([...BASE, '--no-headless']);
    expect(saved).not.toContain('--no-headless');
    expect(saved).not.toContain('--headless');
  });

  it('保存时只吞掉布尔词，不吞别的参数；用户的自定义 flag 原样保留', () => {
    const saved = resave([...BASE, '--headless', 'false', '--proxyServer=http://p:1', '--browserUrl', 'x']);
    expect(saved).toEqual(expect.arrayContaining(['--proxyServer=http://p:1', '--browserUrl', 'x']));
    expect(saved).not.toContain('false');
    expect(saved).not.toContain('--headless');
  });

  it('保存两次结果不变（幂等）', () => {
    const once = resave([...BASE, '--headless=true', '--viewport', '1280x800', '--channel=beta']);
    expect(resave(once)).toEqual(once);
  });
});

describe('chrome-devtools 启动参数：菜单循环与冲突', () => {
  it('视口按预设循环，未知值从第一个预设重新开始', () => {
    expect(cycleViewport(undefined)).toBe(VIEWPORT_PRESETS[1]);
    expect(cycleViewport(VIEWPORT_PRESETS.at(-1))).toBeUndefined();
    expect(cycleViewport('999x999')).toBe(VIEWPORT_PRESETS[0]);
  });

  it('通道按 stable → beta → dev → canary → stable 循环', () => {
    expect(cycleChannel('stable')).toBe('beta');
    expect(cycleChannel('canary')).toBe('stable');
  });

  it('auto-connect 让 headless / isolated 失效（不写一个假开关）', () => {
    expect(launchOptionBlocker(DEFAULT_BROWSER_OPTIONS)).toBeUndefined();
    expect(
      launchOptionBlocker({ ...DEFAULT_BROWSER_OPTIONS, autoConnect: true }),
    ).toBe('auto-connect');
  });
});
