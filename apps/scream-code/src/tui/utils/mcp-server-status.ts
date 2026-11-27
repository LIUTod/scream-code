import type { McpServerInfo, McpServerStatusEvent } from '@scream-code/scream-code-sdk';

import type { McpSummary } from '../types';

export type McpServerStatusSnapshot = McpServerInfo | McpServerStatusEvent['server'];
export type McpServerStatus = McpServerStatusSnapshot['status'];

/**
 * How the servers stand. Disabled servers were switched off on purpose and are
 * not counted: they are neither healthy nor a problem.
 */
export function summarizeMcpServers(statuses: ReadonlyMap<string, McpServerStatus>): McpSummary {
  let total = 0;
  let connected = 0;
  let pending = 0;
  let failed = 0;
  let needsAuth = 0;
  for (const status of statuses.values()) {
    if (status === 'disabled') continue;
    total++;
    if (status === 'connected') connected++;
    else if (status === 'pending') pending++;
    else if (status === 'failed') failed++;
    else needsAuth++;
  }
  return { total, connected, pending, failed, needsAuth };
}

/** Names of the servers in one problem state, sorted so the same set always reads the same. */
export function mcpServerNames(
  statuses: ReadonlyMap<string, McpServerStatus>,
  status: 'failed' | 'needs-auth',
): string[] {
  return [...statuses].filter(([, s]) => s === status).map(([name]) => name).toSorted();
}

export function sameMcpSummary(a: McpSummary | undefined, b: McpSummary | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.total === b.total &&
    a.connected === b.connected &&
    a.pending === b.pending &&
    a.failed === b.failed &&
    a.needsAuth === b.needsAuth
  );
}
