/**
 * Subagent capability modes and their tool-set policy.
 *
 * Capability modes (read-only / read-write / execute / all): a mode is
 * enforced at the tool level, not just by prompting. `all` keeps the profile's
 * full tool set; stricter modes strip it down to the tools the mode permits.
 *
 * Tool classification is by name; the sets live in `#/tools/tool-catalog`
 * (shared with the permission policies) so a new tool is classified once.
 * Names the catalog does not classify are refused in every restricted mode
 * (fail-closed): a tool nobody classified must not survive a trim by virtue
 * of being unknown. MCP tools are refused for the same reason — their
 * read/write/execute nature cannot be read off the name.
 */

import {
  CORE_TOOLS,
  EXECUTE_TOOLS,
  NESTING_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '#/tools/tool-catalog';

export type SubagentCapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all';

/** Tool names each restricted mode permits, built once at module load: the
 *  membership test runs for every active tool at spawn and for every tool call
 *  the runtime permission gate inspects. */
const ALLOWED_TOOLS_BY_MODE: Readonly<
  Record<Exclude<SubagentCapabilityMode, 'all'>, ReadonlySet<string>>
> = {
  'read-only': union(READ_TOOLS, CORE_TOOLS),
  'read-write': union(READ_TOOLS, WRITE_TOOLS, CORE_TOOLS),
  execute: union(READ_TOOLS, WRITE_TOOLS, EXECUTE_TOOLS, CORE_TOOLS),
};

/**
 * Whether a tool may be used under `mode` — the single membership test shared
 * by the spawn-time trim (`filterToolsForCapability`) and the runtime
 * permission gate (`agent/permission/policies/capability-guard-deny`), so what
 * the model sees and what may actually run can never disagree.
 *
 * Fail-closed: `all` allows everything; every restricted mode refuses MCP
 * tools and any name the catalog does not classify.
 */
export function isToolAllowedForCapability(name: string, mode: SubagentCapabilityMode): boolean {
  if (mode === 'all') return true;
  // Nesting tools stay in `all` only, checked explicitly so a future catalog
  // edit cannot accidentally admit a spawner to a restricted mode: a
  // restricted child must never spawn a child of its own.
  if (NESTING_TOOLS.has(name)) return false;
  if (name.startsWith('mcp__')) return false;
  return ALLOWED_TOOLS_BY_MODE[mode].has(name);
}

/**
 * Filter an active tool-name list down to what `mode` permits. `all` returns
 * the input unchanged. Restricted modes drop every name outside the mode's
 * set, unclassified names included (fail-closed — classify the tool in
 * `#/tools/tool-catalog` to admit it to a restricted child).
 */
export function filterToolsForCapability(
  activeTools: readonly string[],
  mode: SubagentCapabilityMode | undefined,
): string[] {
  if (mode === undefined || mode === 'all') return [...activeTools];
  return activeTools.filter((name) => isToolAllowedForCapability(name, mode));
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
 * only allowed tools), which is the safe direction for a capability clamp —
 * and an unclassified name can never be inferred into a restricted mode,
 * because every restricted mode drops it (fail-closed).
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
