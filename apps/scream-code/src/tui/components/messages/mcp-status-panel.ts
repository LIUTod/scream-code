import type { McpServerInfo } from '@scream-code/scream-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { t } from '@scream-code/config';

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
  connected: t('mcppanel.connected'),
  pending: t('mcppanel.pending'),
  'needs-auth': t('mcppanel.needs_auth'),
  failed: t('mcppanel.failed'),
  disabled: t('mcppanel.disabled'),
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
  return t('mcppanel.tools_available', { count });
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

  const lines: string[] = [accent(t('mcppanel.servers'))];

  if (servers.length === 0) {
    lines.push(muted(`  ${t('mcppanel.no_config')}`));
    return lines;
  }

  const nameWidth = Math.max(t('mcppanel.name').length, ...servers.map((server) => server.name.length));
  const statusWidth = Math.max(
    t('mcppanel.status').length,
    ...servers.map((server) => STATUS_LABEL[server.status].length),
  );
  const transportWidth = Math.max(
    t('mcppanel.transport').length,
    ...servers.map((server) => server.transport.length),
  );

  lines.push(
    `  ${muted(t('mcppanel.name').padEnd(nameWidth))}  ${muted(t('mcppanel.status').padEnd(statusWidth))}  ${muted(
      t('mcppanel.transport').padEnd(transportWidth),
    )}  ${muted(t('mcppanel.tools'))}`,
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
      lines.push(`    ${muted(t('mcppanel.error'))} ${error(server.error.trim())}`);
    }
    if (server.status === 'needs-auth') {
      lines.push(`    ${muted(t('mcppanel.action'))} ${value(t('mcppanel.run_mcp'))}`);
    }
  }

  lines.push('');
  lines.push(`  ${value(buildSummary(servers))}`);

  return lines;
}
