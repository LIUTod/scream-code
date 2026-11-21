/**
 * Single catalog of builtin-tool name sets shared by permission and
 * capability policies. When adding a tool, classify it here once: the
 * subagent capability filter and the default-approve policy both read from
 * this file, so no list has to be synced by hand in two places.
 *
 * `DEFAULT_AUTO_APPROVE_TOOLS` is copied verbatim from the former per-file
 * record (including its legacy `SetTodoList` entry) so behavior is
 * unchanged; the sets are intentionally not re-derived from tool
 * definitions.
 */

/** Read-only inspection tools (no workspace mutation, no command execution). */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'AstGrep',
  'ContactParent',
  'DiscoverMcpTools',
  'FetchURL',
  'Glob',
  'Grep',
  'KnowledgeLookup',
  'LSP',
  'ListMcpResources',
  'ListMcpResourceTemplates',
  'MemoryLookup',
  'PaperSearch',
  'Read',
  'ReadGroup',
  'ReadMcpResource',
  'ReadMediaFile',
  'ReportArchFinding',
  'ReportFinding',
  'Skill',
  'TodoList',
  'WebSearch',
]);

/** Tools that mutate the workspace (files, memory, plans, skills). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'AstEdit',
  'Edit',
  'ImageGenerate',
  'InspectOwnAssets',
  'MakeSkillApply',
  'MakeSkillPlan',
  'ManagePlugin',
  'MemoryEdit',
  'MemoryWrite',
  'Write',
]);

/** Tools that execute commands. */
export const EXECUTE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Python', 'RunScript']);

/** Nesting/coordination tools — only `all` mode keeps them. A restricted
 *  child must not be able to spawn an unrestricted grandchild (that would
 *  bypass the tool filtering entirely). WolfPack is batch-spawn sugar over
 *  the same subagent host, so it is filtered too. */
export const NESTING_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'SendSubagentMessage',
  'WolfPack',
]);

/** Goal/session-management tools, always available regardless of mode. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'WriteGoalNote',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/**
 * Tools approved by the catalog without asking, verbatim from the former
 * default-tool-approve record. `SetTodoList` is a legacy name kept
 * as-is: no current tool declares it, and removing it would be a behavior
 * change rather than a refactor.
 */
export const DEFAULT_AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'InspectOwnAssets',
  'DiscoverMcpTools',
  'ListMcpResources',
  'ListMcpResourceTemplates',
  'ReadMcpResource',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  // The job ledger is the same kind of read as TaskList / CronList above. It was
  // absent, so ask mode sent `JobList` to the approval prompt — which in a
  // background report job (ask mode, no approval handler) is not a question but
  // a refusal, and the run had to fall back to reading `host/jobs.json` by hand.
  'JobList',
  'WebSearch',
  'PaperSearch',
  'FetchURL',
  'Agent',
  'AskUserQuestion',
  'Skill',
  'WolfPack',
  'CreateGoal',
  'UpdateGoal',
  'GetGoal',
  'SetGoalBudget',
  'WriteGoalNote',
  'MakeSkillPlan',
  'MakeSkillApply',
]);
