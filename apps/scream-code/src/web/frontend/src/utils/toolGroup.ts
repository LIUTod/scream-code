import type { ToolMessage } from '../types';

export interface ToolGroupData {
  name: string;
  tools: ToolMessage[];
}

/** Group consecutive tools with the same name for collapsible display. */
export function groupConsecutiveTools(tools: ToolMessage[]): ToolGroupData[] {
  const groups: ToolGroupData[] = [];
  for (const tool of tools) {
    const last = groups.at(-1);
    if (last && last.name === tool.name) {
      last.tools.push(tool);
    } else {
      groups.push({ name: tool.name, tools: [tool] });
    }
  }
  return groups;
}

const EDIT_TOOL_NAMES = new Set([
  'edit', 'str_replace', 'replace', 'write', 'multi_edit',
  'create_file', 'edit_file', 'apply_patch',
]);

export function isEditTool(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name.toLowerCase());
}

export type ToolStatus = 'ok' | 'error' | 'running' | 'suspended';

export function toolStatus(tool: ToolMessage): ToolStatus {
  if (tool.suspended) return 'suspended';
  if (tool.isError) return 'error';
  if (tool.output === undefined) return 'running';
  return 'ok';
}

export function aggregateStatus(tools: ToolMessage[]): ToolStatus {
  if (tools.some((t) => toolStatus(t) === 'running')) return 'running';
  if (tools.some((t) => toolStatus(t) === 'error')) return 'error';
  return 'ok';
}
