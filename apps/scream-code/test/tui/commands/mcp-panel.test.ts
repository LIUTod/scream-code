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

import { buildRows, handleDelete, handleEnter, uninstallMcp } from '#/tui/commands/mcp';
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
  listMcpServers: ReturnType<typeof vi.fn>;
}

/** Minimal host surface the command layer touches, with everything spied. */
function makeHost(): {
  host: SlashCommandHost;
  session: SessionStub;
  showError: ReturnType<typeof vi.fn>;
  showStatus: ReturnType<typeof vi.fn>;
  mountEditorReplacement: ReturnType<typeof vi.fn>;
} {
  const session: SessionStub = {
    removeMcpServer: vi.fn(async () => undefined),
    stopMcpServer: vi.fn(async () => undefined),
    reconnectMcpServer: vi.fn(async () => undefined),
    listMcpServers: vi.fn(async () => []),
  };
  const showError = vi.fn();
  const showStatus = vi.fn();
  const mountEditorReplacement = vi.fn();
  const host = {
    session,
    showError,
    showStatus,
    mountEditorReplacement,
    restoreEditor: vi.fn(),
    state: { theme: { colors: {} } },
  } as unknown as SlashCommandHost;
  return { host, session, showError, showStatus, mountEditorReplacement };
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
