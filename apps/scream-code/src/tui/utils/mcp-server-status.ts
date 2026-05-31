import type { McpServerInfo, McpServerStatusEvent } from '@scream-cli/scream-code-sdk';

export type McpServerStatusSnapshot = McpServerInfo | McpServerStatusEvent['server'];

export const MCP_STARTUP_STATUS_ROW_LIMIT = 4;

function mcpStartupStatusPriority(status: McpServerStatusSnapshot['status']): number {
  switch (status) {
    case 'failed':
      return 0;
    case 'needs-auth':
      return 1;
    case 'pending':
      return 2;
    case 'connected':
      return 3;
    case 'disabled':
      return 4;
  }
}

export function selectMcpStartupStatusRows(
  servers: readonly McpServerStatusSnapshot[],
): McpServerStatusSnapshot[] {
  return [...servers]
    .filter((server) => server.status !== 'disabled')
    .toSorted((a, b) => mcpStartupStatusPriority(a.status) - mcpStartupStatusPriority(b.status))
    .slice(0, MCP_STARTUP_STATUS_ROW_LIMIT);
}

export function formatMcpStartupStatusSummary(
  hidden: readonly McpServerStatusSnapshot[],
  visibleCount: number,
): string {
  let failed = 0;
  let needsAuth = 0;
  let connecting = 0;
  let connected = 0;
  let disabled = 0;
  for (const server of hidden) {
    switch (server.status) {
      case 'failed':
        failed++;
        break;
      case 'needs-auth':
        needsAuth++;
        break;
      case 'pending':
        connecting++;
        break;
      case 'connected':
        connected++;
        break;
      case 'disabled':
        disabled++;
        break;
    }
  }

  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} 失败`);
  if (needsAuth > 0) parts.push(`${needsAuth} 需要认证`);
  if (connecting > 0) parts.push(`${connecting} 连接中`);
  if (connected > 0) parts.push(`${connected} 已连接`);
  if (disabled > 0) parts.push(`${disabled} 已禁用`);
  const detail = parts.join(', ');
  if (visibleCount === 0) return `MCP 服务器: ${detail}`;
  return `MCP 服务器: ${hidden.length} 个更多 (${detail})`;
}

export function mcpServerStatusKey(server: McpServerStatusSnapshot): string {
  return JSON.stringify([server.status, server.transport, server.toolCount, server.error]);
}
