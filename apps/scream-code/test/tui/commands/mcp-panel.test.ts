import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 数据目录隔离：卸载链路会读写 mcp.json，绝不能落到真实 ~/.scream-code。
const pathsStub = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('#/utils/paths', () => ({ getDataDir: () => pathsStub.dataDir }));

// 项目级 mcp.json 链由 SDK 解析；测试里把它指到临时文件，避免读真实项目配置。
const mcpPaths = vi.hoisted(() => ({ project: '', parents: [] as string[] }));
vi.mock('@scream-code/scream-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@scream-code/scream-code-sdk')>();
  return {
    ...actual,
    resolveMcpJsonPaths: () => ({ user: '', project: mcpPaths.project, parents: mcpPaths.parents }),
  };
});

import { buildRows, handleAuthenticate, handleDelete, handleEnter, handleOptions, missingRecommendedArgs, resolveRecommendationArgs, uninstallMcp } from '#/tui/commands/mcp';

// `/mcp` 的认证入口会在系统浏览器里打开授权页；测试里只断言「打开了什么」。
vi.mock('#/tui/utils/open-url', () => ({ openUrl: vi.fn() }));
import { openUrl } from '#/tui/utils/open-url';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { pluginIdFromMcpRuntimeName } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';

/** Installed-row lookup helper: sections carry an empty name. */
function installedRow(rows: ReturnType<typeof buildRows>, name: string) {
  return rows.find((row) => row.kind === 'installed' && row.name === name)!;
}

function makeRow(name: string, status: string) {
  return installedRow(buildRows([{ name, status, toolCount: 3 }]), name);
}

interface SessionStub {
  removeMcpServer: ReturnType<typeof vi.fn>;
  stopMcpServer: ReturnType<typeof vi.fn>;
  reconnectMcpServer: ReturnType<typeof vi.fn>;
  addMcpServer: ReturnType<typeof vi.fn>;
  listMcpServers: ReturnType<typeof vi.fn>;
  authenticateMcpServer: ReturnType<typeof vi.fn>;
}

/** Minimal host surface the command layer touches, with everything spied. */
function makeHost(): {
  host: SlashCommandHost;
  session: SessionStub;
  showError: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  mountEditorReplacement: ReturnType<typeof vi.fn>;
  spinnerStop: ReturnType<typeof vi.fn>;
} {
  const session: SessionStub = {
    removeMcpServer: vi.fn(async () => undefined),
    stopMcpServer: vi.fn(async () => undefined),
    reconnectMcpServer: vi.fn(async () => undefined),
    addMcpServer: vi.fn(async () => undefined),
    listMcpServers: vi.fn(async () => []),
    authenticateMcpServer: vi.fn(async () => ({ alreadyAuthorized: false })),
  };
  const showError = vi.fn();
  const showStatus = vi.fn();
  const mountEditorReplacement = vi.fn();
  const spinnerStop = vi.fn();
  const spinner = { stop: spinnerStop, setLabel: vi.fn() };
  const host = {
    session,
    showError,
    showStatus,
    mountEditorReplacement,
    showProgressSpinner: () => spinner,
    restoreEditor: vi.fn(),
    state: { theme: { colors: {} } },
  } as unknown as SlashCommandHost;
  return { host, session, showError, showStatus, mountEditorReplacement, spinnerStop };
}

describe('/mcp 面板的插件归属标注', () => {
  it('插件贡献的 MCP 行标注"插件提供"，普通 MCP 行不标注', () => {
    const rows = buildRows([
      { name: 'plugin-cloudflare:cloudflare', status: 'connected', toolCount: 12 },
      { name: 'chrome-devtools', status: 'connected', toolCount: 32 },
    ]);

    expect(installedRow(rows, 'plugin-cloudflare:cloudflare').description).toContain(
      t('mcp.plugin_owned'),
    );
    expect(installedRow(rows, 'chrome-devtools').description).not.toContain(t('mcp.plugin_owned'));
  });

  it('运行期名 → 插件 id：只有 plugin- 前缀的名字归属插件', () => {
    expect(pluginIdFromMcpRuntimeName('plugin-cloudflare:cloudflare')).toBe('cloudflare');
    expect(pluginIdFromMcpRuntimeName('chrome-devtools')).toBeUndefined();
    expect(pluginIdFromMcpRuntimeName('plugin-')).toBeUndefined();
  });

  it('已连接的行显示服务端自报版本（`@latest` 不等于实际解析到的版本）', () => {
    const rows = buildRows([
      { name: 'chrome-devtools', status: 'connected', toolCount: 48, serverVersion: '1.13.0' },
    ]);

    expect(installedRow(rows, 'chrome-devtools').description).toContain('v1.13.0');
  });

  it('未连接时即便带着旧版本号也不显示（停止的服务器没有 handshake 可依据）', () => {
    const rows = buildRows([
      { name: 'chrome-devtools', status: 'disabled', toolCount: 0, serverVersion: '1.13.0' },
    ]);

    expect(installedRow(rows, 'chrome-devtools').description).not.toContain('v1.13.0');
  });
});

describe('/mcp 卸载与启停的动作语义', () => {
  it('插件行按卸载：直接给说明、不弹确认框、不动运行期', async () => {
    const { host, session, showError, mountEditorReplacement } = makeHost();
    const row = makeRow('plugin-cloudflare:cloudflare', 'connected');

    await handleDelete(host, row);

    expect(showError).toHaveBeenCalledWith(
      t('mcp.uninstall_plugin_blocked', { name: row.name, plugin: 'cloudflare' }),
    );
    expect(session.removeMcpServer).not.toHaveBeenCalled();
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('普通行按卸载：先弹确认框（动作尚未执行）', async () => {
    const { host, session, showError, mountEditorReplacement } = makeHost();
    const row = makeRow('chrome-devtools', 'connected');

    // 确认框是交互式挂载，这里不 settle——只验证进入确认流程。
    void handleDelete(host, row);

    expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    expect(session.removeMcpServer).not.toHaveBeenCalled();
  });

  it('插件行 Enter 停止：真的停止，并如实注明重启后随插件恢复', async () => {
    const { host, session, showStatus } = makeHost();
    const row = makeRow('plugin-cloudflare:cloudflare', 'connected');

    await handleEnter(host, row);

    expect(session.stopMcpServer).toHaveBeenCalledWith('plugin-cloudflare:cloudflare');
    expect(showStatus).toHaveBeenCalledWith(
      t('mcp.disabled_done', { name: row.name }) + ` ${t('mcp.plugin_owned_stop_note')}`,
    );
  });

  it('普通行 Enter 停止：不附加插件说明', async () => {
    const { host, session, showStatus } = makeHost();
    const row = makeRow('chrome-devtools', 'connected');

    await handleEnter(host, row);

    expect(session.stopMcpServer).toHaveBeenCalledWith('chrome-devtools');
    expect(showStatus).toHaveBeenCalledWith(t('mcp.disabled_done', { name: row.name }));
    expect(showStatus.mock.calls[0]?.[0]).not.toContain(t('mcp.plugin_owned_stop_note'));
  });

  it('已停止的行 Enter 重新连接', async () => {
    const { host, session } = makeHost();
    const row = makeRow('chrome-devtools', 'disabled');

    await handleEnter(host, row);

    expect(session.reconnectMcpServer).toHaveBeenCalledWith('chrome-devtools');
    expect(session.stopMcpServer).not.toHaveBeenCalled();
  });
});

describe('/mcp 卸载全链路（mcp.json 落盘 + 复检）', () => {
  beforeEach(() => {
    pathsStub.dataDir = mkdtempSync(join(tmpdir(), 'mcp-panel-'));
    // 默认：项目链不声明任何 server（各用例按需覆盖）。
    mcpPaths.project = join(pathsStub.dataDir, 'no-such-project', '.scream-code', 'mcp.json');
    mcpPaths.parents = [];
    writeFileSync(
      join(pathsStub.dataDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'chrome-devtools': { transport: 'stdio', command: 'npx', args: [] } } }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(pathsStub.dataDir, { recursive: true, force: true });
  });

  function readServers(): Record<string, unknown> {
    const parsed = JSON.parse(readFileSync(join(pathsStub.dataDir, 'mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return parsed.mcpServers ?? {};
  }

  it('卸载成功：运行期移除 + mcp.json 条目删除 + 报已卸载', async () => {
    const { host, session, showStatus, showError } = makeHost();
    session.listMcpServers.mockResolvedValue([]);

    await uninstallMcp(host, 'chrome-devtools');

    expect(session.removeMcpServer).toHaveBeenCalledWith('chrome-devtools');
    expect(Object.keys(readServers())).toEqual([]);
    expect(showStatus).toHaveBeenCalledWith(t('mcp.uninstalled', { name: 'chrome-devtools' }));
    expect(showError).not.toHaveBeenCalled();
  });

  it('移除后仍被列出 → 如实报错，不报假成功', async () => {
    const { host, session, showStatus, showError } = makeHost();
    session.listMcpServers.mockResolvedValue([
      { name: 'chrome-devtools', status: 'connected', toolCount: 1 },
    ]);

    await uninstallMcp(host, 'chrome-devtools');

    expect(showError).toHaveBeenCalledWith(
      t('mcp.uninstall_verify_failed', { name: 'chrome-devtools' }),
    );
    expect(showStatus).not.toHaveBeenCalled();
  });

  it('复检列表自身失败 → 不把已完成的卸载误报为失败', async () => {
    const { host, session, showStatus, showError } = makeHost();
    session.listMcpServers.mockRejectedValue(new Error('rpc down'));

    await uninstallMcp(host, 'chrome-devtools');

    expect(showStatus).toHaveBeenCalledWith(t('mcp.uninstalled', { name: 'chrome-devtools' }));
    expect(showError).not.toHaveBeenCalled();
  });

  it('运行期移除抛错 → 报卸载失败，mcp.json 条目保留', async () => {
    const { host, session, showError, showStatus } = makeHost();
    session.removeMcpServer.mockRejectedValue(new Error('boom'));

    await uninstallMcp(host, 'chrome-devtools');

    expect(showError).toHaveBeenCalledWith(t('mcp.uninstall_failed', { msg: 'boom' }));
    expect(showStatus).not.toHaveBeenCalled();
    expect(Object.keys(readServers())).toEqual(['chrome-devtools']);
  });

  it('项目级配置声明该 server → 拒绝卸载并指出文件（重启会重新加载）', async () => {
    const projectFile = join(pathsStub.dataDir, 'proj', '.scream-code', 'mcp.json');
    mkdirSync(dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ mcpServers: { 'chrome-devtools': { command: 'npx' } } }));
    mcpPaths.project = projectFile;
    const { host, session, showError, showStatus } = makeHost();

    await uninstallMcp(host, 'chrome-devtools');

    expect(showError).toHaveBeenCalledWith(
      t('mcp.uninstall_project_owned', { name: 'chrome-devtools', files: projectFile }),
    );
    expect(session.removeMcpServer).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
    // 用户级配置也不能被顺手改掉
    expect(Object.keys(readServers())).toEqual(['chrome-devtools']);
  });

  it('插件名直通卸载 → 被拦截，不触碰运行期与配置', async () => {
    const { host, session, showError } = makeHost();

    await uninstallMcp(host, 'plugin-cloudflare:cloudflare');

    expect(showError).toHaveBeenCalledWith(
      t('mcp.uninstall_plugin_blocked', { name: 'plugin-cloudflare:cloudflare', plugin: 'cloudflare' }),
    );
    expect(session.removeMcpServer).not.toHaveBeenCalled();
    expect(Object.keys(readServers())).toEqual(['chrome-devtools']);
  });
});

// ─── 推荐参数漂移与更新 ────────────────────────────────────────────────
//
// 内置推荐值是会演进的（新增隐私默认项、新工具类别）。已安装条目的 args
// 停留在安装当天，所以面板必须能识别漂移，并给出一条「重置为推荐值」的
// 明确动作——否则老用户永远拿不到后来加的 flag。

/** 模拟「安装于更早版本」的 args：缺 --redact-network-headers 等新 flag。 */
const STALE_ARGS = [
  '-y',
  'chrome-devtools-mcp@latest',
  '--no-usage-statistics',
  '--no-performance-crux',
  '--screenshot-format=jpeg',
  '--screenshot-quality=85',
  '--screenshot-max-width=1600',
];

function recommendedRow(rows: ReturnType<typeof buildRows>, name: string) {
  return rows.find((row) => row.kind === 'recommended' && row.name === name)!;
}

describe('/mcp 推荐参数漂移检测', () => {
  beforeEach(() => {
    pathsStub.dataDir = mkdtempSync(join(tmpdir(), 'mcp-panel-drift-'));
    mcpPaths.project = join(pathsStub.dataDir, 'no-such-project', '.scream-code', 'mcp.json');
    mcpPaths.parents = [];
    writeFileSync(
      join(pathsStub.dataDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'chrome-devtools': { transport: 'stdio', command: 'npx', args: STALE_ARGS },
        },
      }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(pathsStub.dataDir, { recursive: true, force: true });
  });

  function readServers(): Record<string, { args?: string[] }> {
    const parsed = JSON.parse(readFileSync(join(pathsStub.dataDir, 'mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    return parsed.mcpServers ?? {};
  }

  it('只比较 flag：包说明符（@latest vs 锁版本）与位置参数不算漂移', () => {
    expect(missingRecommendedArgs(STALE_ARGS, ['-y', 'chrome-devtools-mcp@1.13.0', '--no-usage-statistics'])).toEqual([]);
    // npx 的 -y 本身是 flag，缺失要报。
    expect(missingRecommendedArgs(['chrome-devtools-mcp@latest'], ['-y', 'chrome-devtools-mcp@latest'])).toEqual(['-y']);
    // 值写在 token 里：用户调过的值会被列为待更新（确认框承诺覆盖自定义参数）。
    expect(missingRecommendedArgs(['--screenshot-quality=90'], ['--screenshot-quality=85'])).toEqual([
      '--screenshot-quality=85',
    ]);
  });

  it('已安装且参数落后 → 推荐行标注待更新，并给出缺失数量', () => {
    const rows = buildRows(
      [{ name: 'chrome-devtools', status: 'connected', toolCount: 33 }],
      { 'chrome-devtools': STALE_ARGS },
    );
    const row = recommendedRow(rows, 'chrome-devtools');

    expect(row.updateAvailable).toBeGreaterThan(0);
    expect(row.description).toContain(t('mcp.update_available', { count: row.updateAvailable! }));
    expect(row.description).not.toContain(`[${t('mcp.installed')}]`);
  });

  it('未安装 → 保持安装提示，不出现更新标注', () => {
    const rows = buildRows([], {});
    const row = recommendedRow(rows, 'chrome-devtools');

    expect(row.updateAvailable).toBeUndefined();
    expect(row.description).toContain(`[${t('mcp.install_enter')}]`);
  });

  it('待更新行 Enter：先确认，取消时既不落盘也不重启', async () => {
    const { host, session, mountEditorReplacement } = makeHost();
    const row = recommendedRow(
      buildRows(
        [{ name: 'chrome-devtools', status: 'connected', toolCount: 33 }],
        { 'chrome-devtools': STALE_ARGS },
      ),
      'chrome-devtools',
    );

    const pending = handleEnter(host, row);
    expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
    // 默认选中「取消」：直接回车 = 放弃。
    const picker = mountEditorReplacement.mock.calls[0]?.[0] as { handleInput: (data: string) => void };
    picker.handleInput('\r');
    await pending;

    expect(session.addMcpServer).not.toHaveBeenCalled();
    expect(readServers()['chrome-devtools']?.args).toEqual(STALE_ARGS);
  });

  it('确认后：mcp.json 与运行期拿到同一次启动参数（不漂移）', async () => {
    const { host, session, mountEditorReplacement, spinnerStop } = makeHost();
    const row = recommendedRow(
      buildRows(
        [{ name: 'chrome-devtools', status: 'connected', toolCount: 33 }],
        { 'chrome-devtools': STALE_ARGS },
      ),
      'chrome-devtools',
    );

    const pending = handleEnter(host, row);
    const picker = mountEditorReplacement.mock.calls[0]?.[0] as { handleInput: (data: string) => void };
    picker.handleInput('\u001B[B'); // 选中「是」
    picker.handleInput('\r');
    await pending;

    const persisted = readServers()['chrome-devtools']?.args ?? [];
    const registered = session.addMcpServer.mock.calls[0]?.[1] as { args: string[] };
    expect(persisted).toContain('--redact-network-headers');
    expect(persisted).toContain('--no-file-navigations');
    expect(persisted).toContain('--category-network-mocks');
    expect(registered.args).toEqual(persisted);
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: true,
      label: t('mcp.update_done', { name: 'Chrome DevTools' }),
    });
  });

  it('项目级声明该条目 → 拒绝更新并指出文件（重启会重新加载）', async () => {
    const projectFile = join(pathsStub.dataDir, 'proj', '.scream-code', 'mcp.json');
    mkdirSync(dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, JSON.stringify({ mcpServers: { 'chrome-devtools': { command: 'npx' } } }));
    mcpPaths.project = projectFile;
    const { host, session, showError, mountEditorReplacement } = makeHost();
    const row = recommendedRow(
      buildRows(
        [{ name: 'chrome-devtools', status: 'connected', toolCount: 33 }],
        { 'chrome-devtools': STALE_ARGS },
      ),
      'chrome-devtools',
    );

    await handleEnter(host, row);

    expect(showError).toHaveBeenCalledWith(
      t('mcp.uninstall_project_owned', { name: 'chrome-devtools', files: projectFile }),
    );
    expect(mountEditorReplacement).not.toHaveBeenCalled();
    expect(session.addMcpServer).not.toHaveBeenCalled();
  });

  it('没有已安装参数可对照（项目级/插件来源）→ Enter 报「已安装」，不误触发更新', async () => {
    const { host, session, showStatus, mountEditorReplacement } = makeHost();
    const rows = buildRows([{ name: 'chrome-devtools', status: 'connected', toolCount: 33 }], {});
    const row = recommendedRow(rows, 'chrome-devtools');

    expect(row.updateAvailable).toBeUndefined();
    await handleEnter(host, row);

    expect(showStatus).toHaveBeenCalledWith(t('mcp.already_installed', { name: 'Chrome DevTools' }));
    expect(mountEditorReplacement).not.toHaveBeenCalled();
    expect(session.addMcpServer).not.toHaveBeenCalled();
  });
});

// ─── 运行形态子菜单（o） ──────────────────────────────────────────────
//
// 子菜单改的是启动参数，因此必须「切换只在内存、保存才写盘」：每次写盘都要
// 重启一次 Chrome，逐项保存会让菜单变成折磨。

describe('/mcp 运行形态子菜单', () => {
  beforeEach(() => {
    pathsStub.dataDir = mkdtempSync(join(tmpdir(), 'mcp-options-'));
    mcpPaths.project = join(pathsStub.dataDir, 'no-such-project', '.scream-code', 'mcp.json');
    mcpPaths.parents = [];
    writeFileSync(
      join(pathsStub.dataDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'chrome-devtools': { transport: 'stdio', command: 'npx', args: STALE_ARGS },
        },
      }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(pathsStub.dataDir, { recursive: true, force: true });
  });

  function readServers(): Record<string, { args?: string[] }> {
    const parsed = JSON.parse(readFileSync(join(pathsStub.dataDir, 'mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    return parsed.mcpServers ?? {};
  }

  it('没有可调选项的推荐 → 只提示，不挂菜单', async () => {
    const { host, showStatus, mountEditorReplacement } = makeHost();

    const row = makeRow('scream-life', 'connected');
    await handleOptions(host, row);

    expect(showStatus).toHaveBeenCalledWith(
      t('mcp.opt_not_available', { name: row.label }),
    );
    expect(mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('切换不落盘；Esc 放弃后配置原样', async () => {
    const { host, session, mountEditorReplacement } = makeHost();

    const pending = handleOptions(host, makeRow('chrome-devtools', 'connected'));
    // 菜单先读 npm 缓存/技能清单（异步），挂载发生在其后。
    await vi.waitFor(() => {
      expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
    });
    const picker = mountEditorReplacement.mock.calls[0]?.[0] as { handleInput: (data: string) => void };
    picker.handleInput('\r'); // 第一项 = headless，切到开
    picker.handleInput('\u001B'); // Esc 放弃
    await pending;

    expect(session.addMcpServer).not.toHaveBeenCalled();
    expect(readServers()['chrome-devtools']?.args).toEqual(STALE_ARGS);
  });

  it('「保存并重启」写入选项并重连（同一次启动参数）', async () => {
    const { host, session, mountEditorReplacement, spinnerStop } = makeHost();

    const pending = handleOptions(host, makeRow('chrome-devtools', 'connected'));
    await vi.waitFor(() => {
      expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
    });
    const picker = mountEditorReplacement.mock.calls[0]?.[0] as { handleInput: (data: string) => void };
    picker.handleInput('\r'); // headless = on
    // 一路按到底即可命中最后一项（选择不会越过末行），避免对行数做断言。
    for (let step = 0; step < 20; step += 1) picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await pending;

    const persisted = readServers()['chrome-devtools']?.args ?? [];
    const registered = session.addMcpServer.mock.calls[0]?.[1] as { args: string[] };
    expect(persisted).toContain('--headless');
    // 保存走的是同一条 applyRecommendedArgs：产品自有 flag 会被一并补齐。
    expect(persisted).toContain('--redact-network-headers');
    expect(registered.args).toEqual(persisted);
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: true,
      label: t('mcp.opt_applied', { name: 'Chrome DevTools' }),
    });
  });
});

// ─── 认证入口（a） ─────────────────────────────────────────────────────
//
// 之前 needs-auth 的提示是「请运行 /mcp」，而 /mcp 里没有认证动作——死胡同。
// 现在：needs-auth 行标注 [a 认证]，Enter 只指路，a 才真的发起流程。

describe('/mcp 认证入口（a）', () => {
  beforeEach(() => {
    (openUrl as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it('needs-auth 行在描述里标注 [a 认证]', () => {
    const rows = buildRows([{ name: 'notion', status: 'needs-auth', toolCount: 0 }]);
    expect(rows.find((row) => row.name === 'notion')?.description).toContain(
      `[a ${t('mcp.auth_action')}]`,
    );
  });

  it('needs-auth 行 Enter 只提示按 a，不会发起注定失败的重连', async () => {
    const { host, session, showStatus } = makeHost();
    const row = makeRow('notion', 'needs-auth');

    await handleEnter(host, row);

    expect(showStatus).toHaveBeenCalledWith(t('mcp.auth_needed_hint', { name: row.label }));
    expect(session.addMcpServer).not.toHaveBeenCalled();
  });

  it('a → 打开授权页并给出 URL 兜底提示', async () => {
    const { host, session, showStatus, spinnerStop } = makeHost();
    session.authenticateMcpServer.mockResolvedValue({
      authorizationUrl: 'https://as.example/authorize?state=abc',
      alreadyAuthorized: false,
    });

    await handleAuthenticate(host, makeRow('notion', 'needs-auth'));

    expect(session.authenticateMcpServer).toHaveBeenCalledWith('notion');
    expect(openUrl).toHaveBeenCalledWith('https://as.example/authorize?state=abc');
    expect(showStatus).toHaveBeenCalledWith(
      t('mcp.auth_url_hint', { url: 'https://as.example/authorize?state=abc' }),
    );
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: true,
      label: t('mcp.auth_opened', { name: 'notion' }),
    });
  });

  it('a → 已有有效凭据时只报告已重连，不弹浏览器', async () => {
    const { host, session, spinnerStop } = makeHost();
    session.authenticateMcpServer.mockResolvedValue({ alreadyAuthorized: true });

    await handleAuthenticate(host, makeRow('notion', 'needs-auth'));

    expect(openUrl).not.toHaveBeenCalled();
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: true,
      label: t('mcp.auth_reconnected', { name: 'notion' }),
    });
  });

  it('a → stdio 服务器等失败场景：把原因原样报出来', async () => {
    const { host, session, showError, spinnerStop } = makeHost();
    session.authenticateMcpServer.mockRejectedValue(
      new Error('"chrome-devtools" is a stdio server: it authenticates through its own command or env, not OAuth'),
    );

    await handleAuthenticate(host, makeRow('chrome-devtools', 'needs-auth'));

    expect(openUrl).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      t('mcp.auth_failed', {
        msg: '"chrome-devtools" is a stdio server: it authenticates through its own command or env, not OAuth',
      }),
    );
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: false,
      label: t('mcp.auth_failed_label', { name: 'chrome-devtools' }),
    });
  });
});

// ─── 管理写入的边界（占位符 / env / 写成功但重连失败） ────────────────

describe('推荐参数解析（{INSTALL_DIR} 占位符）', () => {
  it('gitUrl 推荐把占位符换成本地安装路径（args 与 env 都要换）', () => {
    const rec = {
      name: 'scream-life',
      displayName: 'ScreamLife',
      description: '',
      command: 'bun',
      args: ['{INSTALL_DIR}/Core/mcp-server.ts'],
      env: { SCREAM_LIFE_DB_PATH: '{INSTALL_DIR}/Data/scream-life.db' },
      gitUrl: 'https://example.com/scream-life.git',
    };

    const resolved = resolveRecommendationArgs(rec, '/data/mcp/scream-life');

    expect(resolved.args).toEqual(['/data/mcp/scream-life/Core/mcp-server.ts']);
    expect(resolved.env).toEqual({
      SCREAM_LIFE_DB_PATH: '/data/mcp/scream-life/Data/scream-life.db',
    });
  });

  it('没有 gitUrl 的推荐原样返回（chrome-devtools 不含占位符）', () => {
    const rec = {
      name: 'chrome-devtools',
      displayName: 'Chrome DevTools',
      description: '',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
    };

    expect(resolveRecommendationArgs(rec, '/tmp/x')).toEqual({
      args: ['-y', 'chrome-devtools-mcp@latest'],
    });
  });
});

describe('/mcp 管理写入的边界', () => {
  beforeEach(() => {
    pathsStub.dataDir = mkdtempSync(join(tmpdir(), 'mcp-write-'));
    mcpPaths.project = join(pathsStub.dataDir, 'no-such-project', '.scream-code', 'mcp.json');
    mcpPaths.parents = [];
    writeFileSync(
      join(pathsStub.dataDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'chrome-devtools': {
            transport: 'stdio',
            command: 'npx',
            args: STALE_ARGS,
            // 用户自己加的代理变量：保存运行选项不该顺手把它删掉。
            env: { HTTPS_PROXY: 'http://proxy.local:3128' },
          },
        },
      }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(pathsStub.dataDir, { recursive: true, force: true });
  });

  function readEntry(): { args?: string[]; env?: Record<string, string> } {
    const parsed = JSON.parse(readFileSync(join(pathsStub.dataDir, 'mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    return parsed.mcpServers?.['chrome-devtools'] ?? {};
  }

  async function openMenuAndToggleHeadless(
    host: SlashCommandHost,
    mountEditorReplacement: ReturnType<typeof vi.fn>,
  ): Promise<{ picker: { handleInput: (data: string) => void }; done: Promise<void> }> {
    // 保存是异步的（写盘 + 重连）：必须把菜单返回的 promise 交给调用方 await，
    // 否则断言跑在写盘之前，测试会以「什么都没变」通过或失败得莫名其妙。
    const done = handleOptions(host, makeRow('chrome-devtools', 'connected'));
    await vi.waitFor(() => {
      expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
    });
    const picker = mountEditorReplacement.mock.calls[0]?.[0] as {
      handleInput: (data: string) => void;
    };
    picker.handleInput('\r'); // 第一项 = headless
    return { picker, done };
  }

  it('保存运行选项保留用户 env，并补上产品自有 env', async () => {
    const { host, mountEditorReplacement } = makeHost();
    const { picker, done } = await openMenuAndToggleHeadless(host, mountEditorReplacement);
    for (let step = 0; step < 20; step += 1) picker.handleInput('\u001B[B');
    picker.handleInput('\r'); // 保存并重启
    await done;

    const entry = readEntry();
    expect(entry.args).toContain('--headless');
    expect(entry.env?.['HTTPS_PROXY']).toBe('http://proxy.local:3128');
    expect(entry.env?.['CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS']).toBe('1');
  });

  it('写入成功但重连失败 → 说清「已保存，重启生效」，不假装成功', async () => {
    const { host, session, mountEditorReplacement, showError, spinnerStop } = makeHost();
    session.addMcpServer.mockRejectedValue(new Error('spawn failed'));
    const { picker, done } = await openMenuAndToggleHeadless(host, mountEditorReplacement);
    for (let step = 0; step < 20; step += 1) picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await done;

    // 文件已经改了：重试「保存」不会让情况更好，提示必须据此措辞。
    expect(readEntry().args).toContain('--headless');
    expect(showError).toHaveBeenCalledWith(
      t('mcp.args_saved_restart_failed', { msg: 'spawn failed' }),
    );
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: false,
      label: t('mcp.args_saved_label', { name: 'Chrome DevTools' }),
    });
  });

  it('开启 auto-connect 会清掉 headless/isolated，不写出被忽略的开关', async () => {
    const { host, mountEditorReplacement } = makeHost();
    const { picker, done } = await openMenuAndToggleHeadless(host, mountEditorReplacement);
    // headless → isolated → viewport → channel → autoconnect
    for (let step = 0; step < 4; step += 1) picker.handleInput('\u001B[B');
    picker.handleInput('\r'); // 打开 auto-connect
    for (let step = 0; step < 20; step += 1) picker.handleInput('\u001B[B');
    picker.handleInput('\r'); // 保存
    await done;

    const args = readEntry().args ?? [];
    expect(args).toContain('--auto-connect');
    expect(args).not.toContain('--headless');
  });
});

describe('/mcp 写入不吞掉用户自己的东西', () => {
  function seed(entry: Record<string, unknown>): void {
    pathsStub.dataDir = mkdtempSync(join(tmpdir(), 'mcp-preserve-'));
    mcpPaths.project = join(pathsStub.dataDir, 'no-such-project', '.scream-code', 'mcp.json');
    mcpPaths.parents = [];
    writeFileSync(
      join(pathsStub.dataDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'chrome-devtools': { transport: 'stdio', ...entry } } }, null, 2),
      'utf-8',
    );
  }

  afterEach(() => {
    rmSync(pathsStub.dataDir, { recursive: true, force: true });
  });

  function readRaw(): Record<string, unknown> {
    const parsed = JSON.parse(readFileSync(join(pathsStub.dataDir, 'mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    return parsed.mcpServers?.['chrome-devtools'] ?? {};
  }

  async function applyHeadless(
    host: SlashCommandHost,
    mountEditorReplacement: ReturnType<typeof vi.fn>,
  ): Promise<void> {
    const done = handleOptions(host, makeRow('chrome-devtools', 'connected'));
    await vi.waitFor(() => {
      expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
    });
    const picker = mountEditorReplacement.mock.calls[0]?.[0] as {
      handleInput: (data: string) => void;
    };
    picker.handleInput('\r'); // headless = on
    for (let step = 0; step < 20; step += 1) picker.handleInput('\u001B[B');
    picker.handleInput('\r'); // 保存
    await done;
  }

  it('菜单只改它认识的 flag：自定义 flag 与锁定的包版本都保留', async () => {
    seed({
      command: 'npx',
      args: [
        '-y',
        'chrome-devtools-mcp@1.13.0',
        '--browserUrl',
        'http://127.0.0.1:9222',
        '--proxy-server=http://proxy.local:8080',
      ],
    });
    const { host, mountEditorReplacement } = makeHost();

    await applyHeadless(host, mountEditorReplacement);

    const args = readRaw()['args'] as string[];
    expect(args).toContain('--headless');
    expect(args).toContain('--browserUrl');
    expect(args).toContain('http://127.0.0.1:9222');
    expect(args).toContain('--proxy-server=http://proxy.local:8080');
    // 锁定版本不被静默改成 @latest。
    expect(args).toContain('chrome-devtools-mcp@1.13.0');
    expect(args).not.toContain('chrome-devtools-mcp@latest');
  });

  it('schema 里的其它字段（exposure/toolTimeoutMs/enabledTools）与自定义 command 不被抹掉', async () => {
    seed({
      command: '/usr/local/bin/npx-wrapper',
      args: STALE_ARGS,
      exposure: 'portal',
      toolTimeoutMs: 5000,
      enabledTools: ['click', 'take_snapshot'],
    });
    const { host, mountEditorReplacement } = makeHost();

    await applyHeadless(host, mountEditorReplacement);

    const entry = readRaw();
    expect(entry['exposure']).toBe('portal');
    expect(entry['toolTimeoutMs']).toBe(5000);
    expect(entry['enabledTools']).toEqual(['click', 'take_snapshot']);
    expect(entry['command']).toBe('/usr/local/bin/npx-wrapper');
  });

  it('enabled: false 的条目只写不启动，并且如实说明', async () => {
    seed({ command: 'npx', args: STALE_ARGS, enabled: false });
    const { host, session, mountEditorReplacement, spinnerStop } = makeHost();

    await applyHeadless(host, mountEditorReplacement);

    expect(readRaw()['args']).toContain('--headless');
    expect(session.addMcpServer).not.toHaveBeenCalled();
    expect(spinnerStop).toHaveBeenCalledWith({
      ok: true,
      label: t('mcp.args_saved_parked', { name: 'Chrome DevTools' }),
    });
  });
});
