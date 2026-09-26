/**
 * Subagent capability modes and their tool-set policy.
 *
 * Capability modes (read-only / read-write / execute / all): a mode is
 * enforced at the tool level, not just by prompting. `all` keeps the profile's
 * full tool set; stricter modes strip it down to the tools the mode permits.
 *
 * Tool classification is by name; the sets live in `#/tools/tool-catalog`
 * (shared with the permission policies) so a new tool is classified once.
 * Unknown tool names are kept (a future tool should fail open rather than
 * being silently stripped from a read-only child).
 */

import {
  CORE_TOOLS,
  EXECUTE_TOOLS,
  NESTING_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '#/tools/tool-catalog';

export type SubagentCapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all';

const KNOWN_TOOL_SETS: readonly ReadonlySet<string>[] = [
  READ_TOOLS,
  WRITE_TOOLS,
  EXECUTE_TOOLS,
  NESTING_TOOLS,
  CORE_TOOLS,
];

/**
 * Filter an active tool-name list down to what `mode` permits. `all` returns
 * the input unchanged. Unknown names are preserved.
 */
export function filterToolsForCapability(
  activeTools: readonly string[],
  mode: SubagentCapabilityMode | undefined,
): string[] {
  if (mode === undefined || mode === 'all') return [...activeTools];
  const allowed =
    mode === 'read-only'
      ? union(READ_TOOLS, CORE_TOOLS)
      : mode === 'read-write'
        ? union(READ_TOOLS, WRITE_TOOLS, CORE_TOOLS)
        : union(READ_TOOLS, WRITE_TOOLS, EXECUTE_TOOLS, CORE_TOOLS);
  return activeTools.filter((name) => {
    // MCP tools are fail-closed in restricted modes: their read/write/execute
    // nature cannot be statically determined, so a restricted child must not
    // keep them. (We are already past the `all` early-return above.)
    if (name.startsWith('mcp__')) return false;
    return allowed.has(name) || !KNOWN_TOOL_SETS.some((set) => set.has(name));
  });
}

function union(...sets: readonly ReadonlySet<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}
