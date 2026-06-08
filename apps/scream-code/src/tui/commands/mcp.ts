/**
 * /mcp — MCP 服务器管理面板。
 *
 * 查看已安装的 MCP 服务器状态，一键安装推荐服务器。 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { getDataDir } from '#/utils/paths';
import type { ColorPalette } from '#/tui/theme/colors';
import { SELECT_POINTER } from '../constant/symbols';
import type { SlashCommandHost } from './dispatch';

// ─── 内置推荐列表 ──────────────────────────────────────────────────────

interface McpRecommendation {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  /** If true, only available on macOS */
  macOnly?: boolean;
}

const RECOMMENDED: McpRecommendation[] = [
  {
    name: 'peekaboo',
    displayName: 'Peekaboo',
    description: 'macOS 桌面自动化：截图/点击/键入/滚动/窗口管理（Background delivery，无需聚焦）',
    command: 'npx',
    args: ['-y', '@steipete/peekaboo', 'mcp'],
    macOnly: true,
  },
  {
    name: 'chrome-devtools',
    displayName: 'Chrome DevTools',
    description: '浏览器自动化：46 个工具，支持导航/点击/填表/截图/性能分析/内存调试/扩展管理',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', '--no-usage-statistics'],
  },
];

// ─── 状态映射 ─────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: '⏳ 连接中',
  connected: '🔌 已连接',
  failed: '❌ 失败',
  disabled: '⏸ 已停用',
  'needs-auth': '🔐 需授权',
};

// ─── Handler ──────────────────────────────────────────────────────────

export async function handleMcpCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  if (!host.session) {
    host.showError('请先创建或恢复一个会话。');
    return;
  }
  await openMcpPanel(host);
}

// ─── 主面板 ───────────────────────────────────────────────────────────

interface McpRow {
  kind: 'installed' | 'recommended';
  name: string;
  label: string;
  status?: string;
  toolCount?: number;
  error?: string;
  description?: string;
  alreadyInstalled?: boolean;
}

async function openMcpPanel(host: SlashCommandHost): Promise<void> {
  const servers = await loadServers(host);
  const rows = buildRows(servers);
  const connectedCount = servers.filter((s) => s.status === 'connected').length;

  let picker: McpPickerComponent;

  const refreshPanel = async () => {
    const s = await loadServers(host);
    const r = buildRows(s);
    const cc = s.filter((x) => x.status === 'connected').length;
    picker.refresh(r, `MCP 管理（${cc}/${s.length} 已连接）`);
    host.mountEditorReplacement(picker);
  };

  picker = new McpPickerComponent({
    title: `MCP 管理（${connectedCount}/${servers.length} 已连接）`,
    rows,
    colors: host.state.theme.colors,
    onEnter: (row) => {
      void (async () => {
        host.restoreEditor();
        await handleEnter(host, row);
        await refreshPanel();
      })();
    },
    onDelete: (row) => {
      void (async () => {
        host.restoreEditor();
        await handleDelete(host, row);
        await refreshPanel();
      })();
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}

// ─── 数据加载 ─────────────────────────────────────────────────────────

async function loadServers(
  host: SlashCommandHost,
): Promise<readonly { name: string; status: string; toolCount: number; error?: string }[]> {
  if (!host.session) return [];
  try {
    return await host.session.listMcpServers();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    host.showError(`加载 MCP 服务器失败：${msg}`);
    return [];
  }
}

/** Replace newlines so error messages don't break single-line terminal rendering. */
function sanitizeDesc(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildRows(
  servers: readonly { name: string; status: string; toolCount: number; error?: string }[],
): McpRow[] {
  const rows: McpRow[] = [];
  // A server that's installed but in a failed state should still be
  // retryable — don't mark it "already installed" in recommendations.
  const installedNames = new Set(
    servers.filter((s) => s.status !== 'failed').map((s) => s.name),
  );

  if (servers.length > 0) {
    rows.push({ kind: 'installed', name: '', label: '── 已安装 ──', status: '__section' });
    for (const s of servers) {
      const statusLabel = STATUS_LABELS[s.status] ?? s.status;
      const toolInfo = s.status === 'connected' ? `${s.toolCount} tools` : '';
      const errorInfo = s.error ? ` — ${sanitizeDesc(s.error)}` : '';
      rows.push({
        kind: 'installed',
        name: s.name,
        label: s.name,
        status: s.status,
        toolCount: s.toolCount,
        error: s.error,
        description: [statusLabel, toolInfo, errorInfo].filter(Boolean).join('  '),
      });
    }
  } else {
    rows.push({
      kind: 'installed', name: '', label: '暂无已安装的 MCP 服务器', status: '__empty',
    });
  }

  rows.push({ kind: 'recommended', name: '', label: '── 推荐 MCP（Enter 安装）──', status: '__section' });
  for (const rec of RECOMMENDED) {
    const alreadyInstalled = installedNames.has(rec.name);
    const platformUnavailable = rec.macOnly && process.platform !== 'darwin';
    rows.push({
      kind: 'recommended',
      name: rec.name,
      label: rec.displayName,
      description: platformUnavailable
        ? `${rec.description}  [仅支持 macOS]`
        : alreadyInstalled
          ? `${rec.description}  [已安装]`
          : `${rec.description}  [Enter 安装]`,
      alreadyInstalled: alreadyInstalled || platformUnavailable,
    });
  }

  return rows;
}

// ─── 动作处理 ────────────────────────────────────────────────────────

async function handleEnter(
  host: SlashCommandHost,
  row: McpRow,
): Promise<void> {
  if (row.kind === 'recommended') {
    if (row.alreadyInstalled) {
      host.showStatus(`${row.label} 已安装，无需重复安装。`);
      return;
    }
    const rec = RECOMMENDED.find((r) => r.name === row.name);
    if (!rec) return;
    await installMcp(host, rec);
  } else if (row.kind === 'installed' && row.status && row.status !== '__section' && row.status !== '__empty') {
    if (row.status === 'connected') {
      await disableMcp(host, row.name);
    } else {
      await enableMcp(host, row.name);
    }
  }
}

async function handleDelete(
  host: SlashCommandHost,
  row: McpRow,
): Promise<void> {
  if (row.kind !== 'installed' || !row.status || row.status === '__section' || row.status === '__empty') {
    return;
  }
  const confirmed = await confirmAction(host, `确认卸载 "${row.label}"？`);
  if (!confirmed) return;
  await uninstallMcp(host, row.name);
}

async function confirmAction(host: SlashCommandHost, title: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new McpPickerComponent({
      title,
      rows: [
        { kind: 'installed', name: 'no', label: '取消' },
        { kind: 'installed', name: 'yes', label: '是，卸载' },
      ],
      colors: host.state.theme.colors,
      onEnter: (r) => {
        host.restoreEditor();
        resolve(r.name === 'yes');
      },
      onDelete: () => {
        host.restoreEditor();
        resolve(false);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

// ─── MCP 操作 ────────────────────────────────────────────────────────

async function installMcp(host: SlashCommandHost, rec: McpRecommendation): Promise<void> {
  const session = host.session;
  if (!session) return;

  const spinner = host.showProgressSpinner(`正在安装 ${rec.displayName}...`);

  spinner.setLabel(`正在配置 ${rec.displayName}...`);
  try {
    await writeMcpConfig(host, rec.name, rec.command, rec.args);
    await session.addMcpServer(rec.name, {
      transport: 'stdio',
      command: rec.command,
      args: rec.args,
    });
    spinner.stop({ ok: true, label: `${rec.displayName} 安装成功并已启动。` });
  } catch (error) {
    spinner.stop({ ok: false, label: `${rec.displayName} 安装失败。` });
    const msg = error instanceof Error ? error.message : String(error);
    const hint = msg.includes('Timed out') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')
      ? '网络超时，建议检查网络或开启加速后重试。'
      : '';
    host.showError(hint ? `安装失败：${msg}\n${hint}` : `安装失败：${msg}`);
  }
}

async function disableMcp(host: SlashCommandHost, name: string): Promise<void> {
  const session = host.session;
  if (!session) return;
  try {
    await session.stopMcpServer(name);
    host.showStatus(`${name} 已停用。`);
  } catch (error) {
    host.showError(
      `停用失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function enableMcp(host: SlashCommandHost, name: string): Promise<void> {
  const session = host.session;
  if (!session) return;
  try {
    await session.reconnectMcpServer(name);
    host.showStatus(`${name} 已检测到安装，正在启动...`);
  } catch (error) {
    host.showError(
      `启动失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function uninstallMcp(host: SlashCommandHost, name: string): Promise<void> {
  const session = host.session;
  if (!session) return;
  try {
    await session.removeMcpServer(name);
    await removeMcpConfig(host, name);
    host.showStatus(`${name} 已卸载。`);
  } catch (error) {
    host.showError(
      `卸载失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── mcp.json 读写 ───────────────────────────────────────────────────

async function writeMcpConfig(
  host: SlashCommandHost,
  name: string,
  command: string,
  args: string[],
): Promise<void> {
  const homeDir = getDataDir();
  const configPath = join(homeDir, 'mcp.json');

  let data: Record<string, unknown> = {};
  try {
    const text = await readFile(configPath, 'utf-8');
    data = JSON.parse(text);
  } catch { /* file doesn't exist yet */ }

  const servers: Record<string, unknown> =
    (data['mcpServers'] as Record<string, unknown>) ?? {};
  servers[name] = { transport: 'stdio', command, args, startupTimeoutMs: 300_000 };
  data['mcpServers'] = servers;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

async function removeMcpConfig(host: SlashCommandHost, name: string): Promise<void> {
  const homeDir = getDataDir();
  const configPath = join(homeDir, 'mcp.json');

  let data: Record<string, unknown> = {};
  try {
    const text = await readFile(configPath, 'utf-8');
    data = JSON.parse(text);
  } catch { return; }

  const servers = (data['mcpServers'] as Record<string, unknown>) ?? {};
  delete servers[name];
  data['mcpServers'] = servers;

  await writeFile(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 自定义选择组件 ──────────────────────────────────────────────────

const ELLIPSIS = '…';

interface McpPickerOptions {
  title: string;
  rows: McpRow[];
  colors: ColorPalette;
  onEnter: (row: McpRow) => void;
  onDelete: (row: McpRow) => void;
  onCancel: () => void;
}

class McpPickerComponent extends Container implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private colors: ColorPalette;
  private title: string;
  private rows: McpRow[];
  private onEnter: (row: McpRow) => void;
  private onDelete: (row: McpRow) => void;
  private onCancel: () => void;
  private maxVisible = 12;

  constructor(opts: McpPickerOptions) {
    super();
    this.title = opts.title;
    this.rows = opts.rows;
    this.colors = opts.colors;
    this.onEnter = opts.onEnter;
    this.onDelete = opts.onDelete;
    this.onCancel = opts.onCancel;
    // Skip section headers for initial selection
    while (
      this.selectedIndex < this.rows.length &&
      this.rows[this.selectedIndex]?.status === '__section'
    ) {
      this.selectedIndex++;
    }
  }

  refresh(rows: McpRow[], title: string): void {
    this.rows = rows;
    this.title = title;
    if (
      this.selectedIndex >= rows.length ||
      rows[this.selectedIndex]?.status === '__section' ||
      rows[this.selectedIndex]?.status === '__empty'
    ) {
      this.selectedIndex = 0;
      while (
        this.selectedIndex < rows.length &&
        (rows[this.selectedIndex]?.status === '__section' ||
          rows[this.selectedIndex]?.status === '__empty')
      ) {
        this.selectedIndex++;
      }
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = this.rows[this.selectedIndex];
      if (row && row.status !== '__section' && row.status !== '__empty') {
        this.onEnter(row);
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.prevSelectable(this.selectedIndex);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.nextSelectable(this.selectedIndex);
      return;
    }
    if (data === 'd' || data === 'D') {
      const row = this.rows[this.selectedIndex];
      if (row && row.kind === 'installed' && row.status && row.status !== '__section' && row.status !== '__empty') {
        this.onDelete(row);
      }
      return;
    }
  }

  private prevSelectable(from: number): number {
    let i = from - 1;
    while (i >= 0) {
      const row = this.rows[i];
      if (row && row.status !== '__section' && row.status !== '__empty') return i;
      i--;
    }
    return from;
  }

  private nextSelectable(from: number): number {
    let i = from + 1;
    while (i < this.rows.length) {
      const row = this.rows[i];
      if (row && row.status !== '__section' && row.status !== '__empty') return i;
      i++;
    }
    return from;
  }

  override render(width: number): string[] {
    const colors = this.colors;
    const lines: string[] = [];

    // Header
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    lines.push(chalk.hex(colors.primary).bold(truncateToWidth(this.title, width, ELLIPSIS)));

    // Hint
    const hint = 'Enter 安装/启停  d 卸载  Esc 返回';
    lines.push(chalk.hex(colors.textMuted)(truncateToWidth(hint, width, ELLIPSIS)));
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));

    // Visible window
    const visibleStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        Math.max(0, this.rows.length - this.maxVisible),
      ),
    );
    const visibleRows = this.rows.slice(visibleStart, visibleStart + this.maxVisible);

    for (const [vi, row] of visibleRows.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === this.selectedIndex;
      const isSection = row.status === '__section';

      if (isSection) {
        lines.push(chalk.hex(colors.textMuted)(truncateToWidth(row.label, width, ELLIPSIS)));
        continue;
      }

      if (row.status === '__empty') {
        lines.push(chalk.hex(colors.textMuted)(truncateToWidth('  ' + row.label, width, ELLIPSIS)));
        continue;
      }

      const pointer = isSelected ? SELECT_POINTER : ' ';
      const pointerColor = isSelected ? colors.primary : colors.textDim;
      const labelColor = isSelected ? colors.primary : colors.text;
      const labelStyle = isSelected ? chalk.hex(labelColor).bold : chalk.hex(labelColor);

      let line = chalk.hex(pointerColor)(pointer + ' ') + labelStyle(row.label);

      if (row.description) {
        const descColor = isSelected ? colors.textDim : colors.textMuted;
        const budget = Math.max(8, width - visibleWidth(line) - 2);
        const desc = truncateToWidth(row.description, budget, ELLIPSIS);
        if (desc.length > 0) {
          line += '  ' + chalk.hex(descColor)(desc);
        }
      }

      line = truncateToWidth(line, width, ELLIPSIS);
      lines.push(line);
    }

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }
}
