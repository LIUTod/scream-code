import type { McpServerInfo } from '@scream-cli/scream-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface McpStatusReportOptions {
  readonly colors: ColorPalette;
  readonly servers: readonly McpServerInfo[];
}

const STATUS_PRIORITY: Record<McpServerInfo['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  pending: 2,
  connected: 3,
  disabled: 4,
};

const STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: '已连接',
  pending: '等待中',
  'needs-auth': '需认证',
  failed: '失败',
  disabled: '已禁用',
};

const SUMMARY_ORDER: readonly McpServerInfo['status'][] = [
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
];

function statusPainter(
  status: McpServerInfo['status'],
  colors: ColorPalette,
): (text: string) => string {
  switch (status) {
    case 'connected':
      return chalk.hex(colors.success);
    case 'failed':
      return chalk.hex(colors.error);
    case 'needs-auth':
    case 'pending':
      return chalk.hex(colors.warning);
    case 'disabled':
      return chalk.hex(colors.textDim);
  }
}

function formatToolCount(server: McpServerInfo): string {
  if (server.status === 'disabled') return '—';
  return `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
}

function formatToolsAvailable(count: number): string {
  return `${count} 个 tool 可用`;
}

function sortedServers(servers: readonly McpServerInfo[]): McpServerInfo[] {
  return servers.toSorted(
    (a, b) =>
      STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name),
  );
}

function buildSummary(servers: readonly McpServerInfo[]): string {
  const counts: Partial<Record<McpServerInfo['status'], number>> = {};
  let toolsAvailable = 0;
  for (const server of servers) {
    counts[server.status] = (counts[server.status] ?? 0) + 1;
    if (server.status === 'connected') toolsAvailable += server.toolCount;
  }
  const parts: string[] = [];
  for (const status of SUMMARY_ORDER) {
    const n = counts[status];
    if (n === undefined || n === 0) continue;
    parts.push(`${n} ${STATUS_LABEL[status]}`);
  }
  parts.push(formatToolsAvailable(toolsAvailable));
  return parts.join(' · ');
}

export function buildMcpStatusReportLines(options: McpStatusReportOptions): string[] {
  const servers = sortedServers(options.servers);
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const muted = chalk.hex(colors.textDim);
  const value = chalk.hex(colors.text);
  const error = chalk.hex(colors.error);

  const lines: string[] = [accent('服务器')];

  if (servers.length === 0) {
    lines.push(muted('  未配置 MCP 服务器。运行 /mcp 添加一个。'));
    return lines;
  }

  const nameWidth = Math.max('名称'.length, ...servers.map((server) => server.name.length));
  const statusWidth = Math.max(
    '状态'.length,
    ...servers.map((server) => STATUS_LABEL[server.status].length),
  );
  const transportWidth = Math.max(
    '传输方式'.length,
    ...servers.map((server) => server.transport.length),
  );

  lines.push(
    `  ${muted('名称'.padEnd(nameWidth))}  ${muted('状态'.padEnd(statusWidth))}  ${muted(
      '传输方式'.padEnd(transportWidth),
    )}  ${muted('工具')}`,
  );

  for (const server of servers) {
    const status = statusPainter(
      server.status,
      colors,
    )(STATUS_LABEL[server.status].padEnd(statusWidth));
    lines.push(
      `  ${value(server.name.padEnd(nameWidth))}  ${status}  ${muted(
        server.transport.padEnd(transportWidth),
      )}  ${value(formatToolCount(server))}`,
    );

    if (
      server.status === 'failed' &&
      server.error !== undefined &&
      server.error.trim().length > 0
    ) {
      lines.push(`    ${muted('错误：')} ${error(server.error.trim())}`);
    }
    if (server.status === 'needs-auth') {
      lines.push(`    ${muted('操作：')} ${value(`运行 /mcp 管理服务器。`)}`);
    }
  }

  lines.push('');
  lines.push(`  ${value(buildSummary(servers))}`);

  return lines;
}
