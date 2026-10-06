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

/** Strictness order: earlier = narrower (fewer tools permitted). */
const CAPABILITY_ORDER: readonly SubagentCapabilityMode[] = [
  'read-only',
  'read-write',
  'execute',
  'all',
];

/**
 * The narrower of two capability modes (`read-only` < `read-write` < `execute`
 * < `all`). Resume uses this to clamp: a resumed agent keeps the tool set it
 * already has (its profile is not rebuilt), so its contract may be re-applied
 * or tightened, never widened.
 */
export function narrowerCapability(
  a: SubagentCapabilityMode,
  b: SubagentCapabilityMode,
): SubagentCapabilityMode {
  return CAPABILITY_ORDER.indexOf(a) <= CAPABILITY_ORDER.indexOf(b) ? a : b;
}

/**
 * Infer the strictest capability mode that already permits `activeTools` — the
 * first mode whose `filterToolsForCapability` pass removes nothing, else `all`.
 *
 * Used when resuming a session recorded before `AgentMeta.capabilityMode`
 * existed: filtering is pure subtraction, so a tool set that survives
 * `read-only` unchanged is evidence the agent was never granted more than
 * that. The inference can only be too *narrow* (a set that happens to contain
 * only allowed tools), which is the safe direction for a capability clamp.
 */
export function inferCapabilityFromTools(
  activeTools: readonly string[],
): SubagentCapabilityMode {
  for (const mode of CAPABILITY_ORDER) {
    if (mode === 'all') break;
    if (filterToolsForCapability(activeTools, mode).length === activeTools.length) return mode;
  }
  return 'all';
}
