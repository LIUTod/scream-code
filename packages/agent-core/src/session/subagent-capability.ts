/**
 * Subagent capability modes and their tool-set policy.
 *
 * Modeled on the reference implementation's capability modes (read-only /
 * read-write / execute / all): a mode is enforced at the tool level, not just
 * by prompting. `all` keeps the profile's full tool set; stricter modes strip
 * it down to the tools the mode permits.
 *
 * Tool classification is by name, matching the BuiltinTool `name` constants.
 * Unknown tool names are kept (a future tool should fail open rather than
 * being silently stripped from a read-only child).
 */

export type SubagentCapabilityMode = 'read-only' | 'read-write' | 'execute' | 'all';

/** Read-only inspection tools (no workspace mutation, no command execution). */
const READ_TOOLS = new Set([
  'AskUserQuestion',
  'FetchURL',
  'Glob',
  'Grep',
  'KnowledgeLookup',
  'LSP',
  'MemoryLookup',
  'Read',
  'ReadGroup',
  'ReadMediaFile',
  'ReportFinding',
  'Skill',
  'TodoList',
  'WebSearch',
]);

/** Tools that mutate the workspace (files, memory, plans, skills). */
const WRITE_TOOLS = new Set([
  'Edit',
  'InspectOwnAssets',
  'MakeSkillApply',
  'MakeSkillPlan',
  'ManagePlugin',
  'MemoryEdit',
  'MemoryWrite',
  'Write',
]);

/** Tools that execute commands. */
const EXECUTE_TOOLS = new Set(['Bash', 'python']);

/** Nesting/coordination tools — only `all` mode keeps them. A restricted
 *  child must not be able to spawn an unrestricted grandchild (that would
 *  bypass the tool filtering entirely). WolfPack is batch-spawn sugar over
 *  the same subagent host, so it is filtered too. */
const NESTING_TOOLS = new Set(['Agent', 'SendSubagentMessage', 'WolfPack']);

/** Goal/session-management tools, always available regardless of mode. */
const CORE_TOOLS = new Set([
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'WriteGoalNote',
  'EnterPlanMode',
  'ExitPlanMode',
]);

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

const KNOWN_TOOL_SETS: ReadonlySet<string>[] = [READ_TOOLS, WRITE_TOOLS, EXECUTE_TOOLS, NESTING_TOOLS, CORE_TOOLS];

function union(...sets: ReadonlySet<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}
