import type { ToolMessage } from '../types';

/** Group consecutive tools with the same name for collapsible display. */
const EDIT_TOOL_NAMES = new Set([
  'edit', 'str_replace', 'replace', 'write', 'multi_edit',
  'create_file', 'edit_file', 'apply_patch',
]);

export function isEditTool(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name.toLowerCase());
}

export type ToolStatus = 'ok' | 'error' | 'running' | 'suspended' | 'unknown';

/**
 * `output === undefined` only means "no result yet" while the turn is live.
 * For a settled or restored message it means the result was never persisted,
 * so reporting `running` pinned the fold to a breathing indicator forever.
 */
export function toolStatus(tool: ToolMessage, live = true): ToolStatus {
  if (tool.suspended) return 'suspended';
  if (tool.isError) return 'error';
  if (tool.output === undefined) return live ? 'running' : 'unknown';
  return 'ok';
}

export function aggregateStatus(tools: ToolMessage[], live = true): ToolStatus {
  const statuses = new Set(tools.map((tool) => toolStatus(tool, live)));
  if (statuses.has('running')) return 'running';
  if (statuses.has('error')) return 'error';
  // Suspended must outrank unknown/ok: a green dot on a call that is parked
  // waiting for approval is the wrong signal.
  if (statuses.has('suspended')) return 'suspended';
  if (statuses.has('unknown')) return 'unknown';
  return 'ok';
}
