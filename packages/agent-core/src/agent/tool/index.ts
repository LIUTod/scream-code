import { uniq } from '@antfu/utils';
import type { ChatProvider, Tool } from '@scream-code/ltod';
import type { Jian } from '@scream-code/jian';
import picomatch from 'picomatch';

import type { Agent } from '..';
import type { HostRequestHandlers } from '../../tools/builtin/python/python';
import type { SubagentHandle } from '../../session/subagent-host';
import { makeErrorPayload } from '../../errors';
import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult } from '../../loop';
import { createMcpAuthTool } from '../../mcp/auth-tool';
import { isRetriableMcpCallError } from '../../mcp/client-shared';
import type { McpConnectionManager, McpServerEntry } from '../../mcp';
import { mcpResultToExecutableOutput } from '../../mcp/output';
import { isMcpToolName, qualifyMcpToolName } from '../../mcp/tool-naming';
import type { MCPClient } from '../../mcp/types';
import { DEFAULT_AGENT_PROFILES } from '../../profile';
import { PLUGIN_CIRCUIT_TRIP_THRESHOLD } from '../../plugin/types';
import { extendWorkspaceWithSkillRoots } from '../../skill';
import type { TodoItem } from '../../todo';
import * as b from '../../tools/builtin';
import { LspTool } from '../../tools/builtin/lsp-tool';
import { LspRegistry } from '../../lsp/registry';
import type { GoalGraderFn } from '../../tools/builtin/goal/update-goal';
import type { ToolStore, ToolStoreData, ToolStoreKey } from '../../tools/store';
import type {
  BuiltinTool,
  McpServerRegistrationResult,
  McpToolCollision,
  ToolInfo,
  UserToolRegistration,
} from './types';

export * from './types';
export { defineUserTool, type DefineUserToolInput } from './define-tool';

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({
    title: todo.title,
    status: todo.status,
    phase: todo.phase,
  }));
}

/** Parse `plugin-<id>:<server>` back to the owning plugin id (undefined otherwise). */
function pluginOwnerFromMcpServerName(serverName: string): string | undefined {
  if (!serverName.startsWith('plugin-')) return undefined;
  const colon = serverName.indexOf(':');
  return colon > 'plugin-'.length ? serverName.slice('plugin-'.length, colon) : undefined;
}

/** Advisory appended to a tool result when its plugin just tripped the circuit. */
function circuitTripNote(pluginId: string): string {
  return (
    `[circuit] Plugin "${pluginId}" failed ${String(PLUGIN_CIRCUIT_TRIP_THRESHOLD)} tool calls in a row ` +
    'and was disabled; its tools, MCP servers, skills, and hooks were pulled from this session. ' +
    `Inspect it with ManagePlugin {action:"check", id:"${pluginId}"}; recover with ` +
    `{action:"reset", id:"${pluginId}"} or abandon it with {action:"remove", id:"${pluginId}"}.`
  );
}

/** Render any tool payload for the advisory appendage without '[object Object]'. */
function describeToolOutput(output: ExecutableToolResult['output']): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

const CRITERIA_SYSTEM_PROMPT = [
  'You generate concrete, verifiable acceptance criteria for a given objective.',
  'Criteria must be specific and testable — state what should work end-to-end, not just what should exist.',
  'Avoid vague criteria like "feature works" or "code is correct".',
  'Respond with JSON only: {"criteria": ["criterion 1", "criterion 2", ...]}',
].join(' ');

const GRADER_SYSTEM_PROMPT = [
  'You are a strict goal completion evaluator. Your default judgment is FAIL. Only PASS when there is clear, specific evidence that every acceptance criterion is genuinely met end-to-end.',
  'Evaluate across three dimensions:',
  '- Completeness: every acceptance criterion is individually met with concrete evidence in the output. Partial completion is FAIL.',
  '- Conformance: the work matches what was asked — no scope drift, no over-engineering, no cutting corners.',
  '- Substance: the output is real, finished, working work — not just a plan, outline, scaffold, stub, mock, or partial implementation, unless the objective specifically asks for those. Surface-level appearance without end-to-end correctness is FAIL.',
  'When FAIL, you MUST list specific issues with actionable fix directions. Do not accept plausible-sounding but unverified claims of completion.',
  'Respond with JSON only.',
].join(' ');

function buildCriteriaPrompt(objective: string): string {
  return [
    '## Objective',
    objective,
    '',
    'Generate 3-8 concrete, verifiable acceptance criteria for this objective.',
    'Each criterion should describe a specific, testable behavior or outcome — focus on end-to-end correctness, not surface existence.',
    'Respond with JSON: {"criteria": ["criterion 1", "criterion 2", ...]}',
  ].join('\n');
}

function buildGraderPrompt(objective: string, criteria: string, output: string): string {
  return [
    '## Objective',
    objective,
    '',
    '## Acceptance Criteria',
    criteria,
    '',
    '## Agent Output',
    output || '(no output captured)',
    '',
    'The Agent Output section contains the following optional parts, in order:',
    '1. The agent\'s natural-language summary of what was done this turn.',
    '2. "## Cross-turn working notes" — short notes the agent recorded using the WriteGoalNote tool across continuation turns. These notes capture key findings, constraints, decisions, and partial results. Treat them as supplementary context when evaluating whether the acceptance criteria are met; they are not the deliverable itself.',
    '3. "## Changes this turn" — a git diff stat (or a note if git is unavailable) showing which files were modified. Use it to verify that the claimed work has an actual code footprint.',
    '',
    'If the Agent Output does not contain a "## Cross-turn working notes" section, add a non-blocking issue: "No cross-turn working notes were provided. Use WriteGoalNote to record key findings, constraints, and partial results across turns." This issue alone must not cause a FAIL.',
    '',
    'Evaluate each dimension independently against the acceptance criteria, then decide overall PASS/FAIL.',
    'When FAIL, list every specific issue with an actionable fix direction so the agent knows exactly what to address next.',
    'Respond with JSON:',
    '{"completeness":{"pass":true/false,"detail":"..."},"conformance":{"pass":true/false,"detail":"..."},"substance":{"pass":true/false,"detail":"..."},"issues":["issue 1: what to fix","issue 2: what to fix"],"pass":true/false,"reason":"overall summary"}',
  ].join('\n');
}

interface GraderResult {
  pass: boolean;
  reason: string;
  /** Formatted dimension breakdown + issues for display. Empty if no structured dims. */
  summary: string;
}

function parseGraderResponse(text: string): GraderResult {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { pass: false, reason: 'No JSON found in grader response', summary: '' };
    const parsed = JSON.parse(match[0]) as {
      pass?: unknown;
      reason?: unknown;
      completeness?: { pass?: unknown; detail?: unknown };
      conformance?: { pass?: unknown; detail?: unknown };
      substance?: { pass?: unknown; detail?: unknown };
      issues?: unknown;
    };

    const overallPass = parsed.pass === true;
    const overallReason = typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided';

    const dims = [parsed.completeness, parsed.conformance, parsed.substance];
    const hasDims = dims.some((d) => d !== undefined);
    if (!hasDims) return { pass: overallPass, reason: overallReason, summary: '' };

    const lines: string[] = [];
    const failedDims: string[] = [];
    for (const [name, dim] of Object.entries({
      Completeness: parsed.completeness,
      Conformance: parsed.conformance,
      Substance: parsed.substance,
    })) {
      if (dim === undefined) continue;
      const ok = dim.pass === true;
      const detail = typeof dim.detail === 'string' ? dim.detail : '';
      lines.push(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
      if (!ok) failedDims.push(`${name}: ${detail}`);
    }

    // Extract issues list
    const issues = Array.isArray(parsed.issues)
      ? (parsed.issues as unknown[]).filter((i): i is string => typeof i === 'string')
      : [];

    if (issues.length > 0) {
      lines.push('');
      lines.push('  Issues to fix:');
      for (const issue of issues) {
        lines.push(`  - ${issue}`);
      }
    }

    const summary = lines.join('\n');

    // Build reason: failed dims + issues for the agent's system reminder
    const reasonParts: string[] = [overallReason];
    if (failedDims.length > 0) reasonParts.push(failedDims.join('\n'));
    if (issues.length > 0) reasonParts.push(`Issues to fix:\n${issues.map((i) => `- ${i}`).join('\n')}`);

    return { pass: overallPass, reason: reasonParts.join('\n'), summary };
  } catch {
    return { pass: false, reason: 'Failed to parse grader response', summary: '' };
  }
}

function extractResponseText(response: { message: { content: { type: string; text?: string }[] } }): string {
  return response.message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

async function generateAcceptanceCriteria(
  agent: Agent,
  objective: string,
): Promise<string> {
  const prompt = buildCriteriaPrompt(objective);
  const response = await agent.rawGenerate(
    agent.config.provider,
    CRITERIA_SYSTEM_PROMPT,
    [],
    [{ role: 'user', content: [{ type: 'text' as const, text: prompt }], toolCalls: [] }],
  );
  const text = extractResponseText(response);
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return '';
    const parsed = JSON.parse(match[0]) as { criteria?: unknown };
    if (!Array.isArray(parsed.criteria)) return '';
    return (parsed.criteria as unknown[])
      .filter((c): c is string => typeof c === 'string')
      .map((c, i) => `${i + 1}. ${c}`)
      .join('\n');
  } catch {
    return '';
  }
}

function createGoalGrader(agent: Agent): GoalGraderFn {
  return async (objective, criterion, output) => {
    // Phase 1: determine acceptance criteria
    let criteria: string;
    if (criterion !== undefined) {
      criteria = criterion;
    } else {
      criteria = await generateAcceptanceCriteria(agent, objective);
      if (!criteria) {
        criteria = 'No specific criteria defined. Evaluate based on whether the objective is clearly achieved.';
      }
    }

    // Phase 2: evaluate against criteria
    const user = buildGraderPrompt(objective, criteria, output);
    const response = await agent.rawGenerate(
      agent.config.provider,
      GRADER_SYSTEM_PROMPT,
      [],
      [{ role: 'user', content: [{ type: 'text' as const, text: user }], toolCalls: [] }],
    );
    const text = extractResponseText(response);
    const result = parseGraderResponse(text);
    const reason = result.summary
      ? `${result.reason}\n${result.summary}`
      : result.reason;
    return { pass: result.pass, reason };
  };
}

interface McpToolEntry {
  readonly tool: ExecutableTool;
  readonly serverName: string;
}

/**
 * Host bridge handlers for the /rlm python kernel: `rlm.run` spawns a
 * subagent (reusing the subagent host) and returns its handle id;
 * `rlm.result` waits for that subagent's final summary. Handles are kept in
 * a closure map for the lifetime of the ToolManager (one per session).
 *
 * Recursion guard: a subagent may only spawn its own rlm() children if its
 * depth is below the cap. Depth is carried on each agent instance (root = 0,
 * every spawned subagent = parent + 1). The cap is per-agent
 * (setRlmMaxDepth / /rlm-max-depth); it is `Infinity` by default — unlimited
 * recursion — and a positive integer when the user opts into a limit.
 */
function createRlmHostHandlers(agent: Agent): HostRequestHandlers {
  const handles = new Map<
    string,
    {
      completion: SubagentHandle['completion'];
      name: string;
      controller: AbortController;
      /** Result cached after the child settles, so a late rlm_wait can still
       * retrieve it. Previously the handle was deleted on settlement, which
       * made rlm_wait fail with "unknown rlm handle" whenever the subagent
       * finished faster than the caller got around to waiting — a real
       * race that burned child results. The entry is only removed once the
       * result has been consumed (or on kernel teardown). */
      result?: unknown;
    }
  >();
  return {
    'rlm.run': async (payload) => {
      const host = agent.subagentHost;
      if (host === undefined) throw new Error('subagent host unavailable');
      if (agent.getRlmDepth() >= agent.getRlmMaxDepth()) {
        throw new Error(
          `RLM recursion depth limit reached (depth ${agent.getRlmDepth()}, max ${agent.getRlmMaxDepth()}). ` +
            'Nested rlm() subagents are not allowed.',
        );
      }
      const task = String(payload['task'] ?? '');
      const name = String(payload['name'] ?? 'subagent').slice(0, 64);
      const controller = new AbortController();
      const handle = await host.spawn('coder', {
        parentToolCallId: `rlm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        prompt: task,
        description: `rlm subagent: ${name}`,
        runInBackground: false,
        signal: controller.signal,
      });
      const entry: { completion: SubagentHandle['completion']; name: string; controller: AbortController; result?: unknown } = {
        completion: handle.completion,
        name,
        controller,
      };
      handles.set(handle.agentId, entry);
      // Cache the result when the child settles. The entry stays in the map
      // until rlm.result consumes it (or teardown), so a fast subagent never
      // races the caller's rlm_wait. Use .then with both callbacks (not
      // .finally) so a rejected completion is consumed instead of surfacing
      // as an unhandled promise rejection (which crashes the process on
      // Node >= 15).
      void handle.completion.then(
        (result) => {
          entry.result = result;
        },
        () => {
          // Child failed or was aborted; keep the entry so rlm.result can
          // surface the error rather than "unknown rlm handle".
          entry.result = undefined;
        },
      );
      return { id: handle.agentId, name };
    },
    'rlm.result': async (payload) => {
      const id = String(payload['id']);
      const entry = handles.get(id);
      if (entry === undefined) throw new Error(`unknown rlm handle: ${id}`);
      if (entry.result !== undefined) {
        handles.delete(id);
        return { result: entry.result };
      }
      const completion = await entry.completion;
      const result = completion.result;
      handles.delete(id);
      return { result };
    },
    // Convention hook invoked by PythonTool.dispose: cancels every in-flight
    // rlm() subagent so a kernel teardown (session close / /rlm off) does not
    // leave children burning tokens with no consumer. After disposal the map
    // is cleared; late rlm.result calls then fail with "unknown rlm handle"
    // instead of awaiting a promise that will never resolve.
    __dispose__: async () => {
      for (const { controller } of handles.values()) {
        controller.abort(new Error('rlm kernel disposed'));
      }
      handles.clear();
      return {};
    },
  };
}

export class ToolManager {
  protected builtinTools: Map<string, BuiltinTool> = new Map();
  protected readonly userTools: Map<string, ExecutableTool> = new Map();
  /** tool name → owning plugin id; the index `unregisterToolsByOwner` reads. */
  protected readonly toolOwners: Map<string, string> = new Map();
  /** plugin id → consecutive capability failures; a success resets to zero. */
  protected readonly circuitFailures: Map<string, number> = new Map();
  protected readonly trippedPlugins: Set<string> = new Set();
  protected readonly mcpTools: Map<string, McpToolEntry> = new Map();
  /** server name → list of qualified tool names registered for that server. */
  protected readonly mcpToolsByServer: Map<string, string[]> = new Map();
  protected enabledTools: Set<string> = new Set();
  /** Glob patterns (e.g. `mcp__*`, `mcp__github__*`) gating which MCP tools the profile exposes. */
  private mcpAccessPatterns: string[] = [];
  protected readonly store: Partial<ToolStoreData> = {};
  private mcpToolStatusUnsubscribe: (() => void) | undefined;
  private lspRegistry: LspRegistry | undefined;
  /** The jian instance the current registry was built for (reuse guard). */
  private lspRegistryJian: Jian | undefined;

  constructor(protected readonly agent: Agent) {
    this.attachMcpTools();
    if (agent.config.hasProvider) {
      this.initializeBuiltinTools();
    }
  }

  /** Exposed so subagent hosts can read cross-turn state such as review findings. */
  get toolStore(): ToolStore {
    return {
      get: ((key: ToolStoreKey) => this.store[key]) as ToolStore['get'],
      set: ((key: ToolStoreKey, value: ToolStoreData[ToolStoreKey]) => {
        this.updateStore(key, value);
      }) as ToolStore['set'],
    };
  }
  attachMcpTools(): void {
    const mcp = this.agent.mcp;
    if (mcp === undefined) return;
    if (this.mcpToolStatusUnsubscribe !== undefined) return;
    for (const entry of mcp.list()) {
      if (entry.status === 'connected') {
        this.registerConnectedMcpServer(mcp, entry);
      } else if (entry.status === 'needs-auth') {
        this.registerNeedsAuthMcpServer(mcp, entry);
      }
    }
    this.mcpToolStatusUnsubscribe = mcp.onStatusChange((entry) => {
      this.handleMcpServerStatusChange(mcp, entry);
    });
  }

  updateStore<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    const storedValue = (
      key === 'todo'
        ? cloneTodos((value ?? []) as readonly TodoItem[])
        : value
    ) as ToolStoreData[K];
    this.agent.records.logRecord({
      type: 'tools.update_store',
      key,
      value: storedValue,
    });
    this.store[key] = storedValue;
    if (key === 'todo') {
      this.agent.emitEvent({ type: 'todo.updated', todos: this.getTodos() });
    }
  }

  getTodos(): readonly TodoItem[] {
    return cloneTodos(this.store.todo ?? []);
  }

  /**
   * Register a user/plugin tool. This is the public entry point for any
   * third-party extension (plugins, skills, future harness adapters) to expose
   * a tool — built-in tools use the internal `builtinTools` map and should not
   * route through here. Prefer `defineTool()` for the typed high-level API;
   * this method takes a hand-written registration.
   */
  registerUserTool(input: UserToolRegistration): void {
    const { name, description, parameters, ownerPluginId, execute } = input;
    // The wire record keeps only serializable fields: `execute` is a closure
    // that cannot be replayed, so a replayed registration correctly falls back
    // to the host-callback path while ownership (needed for teardown) survives.
    this.agent.records.logRecord({
      type: 'tools.register_user_tool',
      name,
      description,
      parameters,
      ...(ownerPluginId !== undefined ? { ownerPluginId } : {}),
    });
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => {
        return {
          description,
          approvalRule: name,
          execute: async (context: ExecutableToolContext) => {
            // Every outcome of a plugin-owned tool answers to the circuit
            // breaker; the note tells the model why the limb just went dead.
            const noteOutcome = (outcome: ExecutableToolResult): ExecutableToolResult => {
              if (ownerPluginId === undefined) return outcome;
              if (this.reportOwnerOutcome(ownerPluginId, outcome.isError !== true) !== 'tripped') {
                return outcome;
              }
              return {
                ...outcome,
                output: `${describeToolOutput(outcome.output)}\n\n${circuitTripNote(ownerPluginId)}`,
              };
            };
            if (execute !== undefined) {
              // In-process path (code plugins): the closure lives in this
              // process and the host cannot call it. A throwing plugin surfaces
              // as a tool error — never a broken loop.
              try {
                const out = await execute(
                  (args ?? {}) as Record<string, unknown>,
                  context,
                );
                return noteOutcome(
                  out ?? { output: `Tool "${name}" returned no result.`, isError: true },
                );
              } catch (error) {
                return noteOutcome({
                  output: `Tool "${name}" failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  isError: true,
                });
              }
            }
            const rpc = this.agent.rpc;
            if (rpc?.toolCall === undefined) {
              // A host without an in-band tool callback cannot service plugin
              // tools; report it as a tool error instead of crashing mid-call.
              // This is a host capability gap, so it does not charge the
              // plugin's breaker budget.
              return {
                output: `User-registered tool "${name}" cannot execute: host does not support in-band tool callbacks.`,
                isError: true,
              };
            }
            return noteOutcome(
              await rpc.toolCall(
                {
                  turnId: Number(context.turnId),
                  toolCallId: context.toolCallId,
                  args,
                },
                { signal: context.signal },
              ),
            );
          },
        };
      },
    };
    this.userTools.set(name, tool);
    this.enabledTools.add(name);
    if (ownerPluginId !== undefined) this.toolOwners.set(name, ownerPluginId);
    else this.toolOwners.delete(name);
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'user.registered',
      toolName: name,
    });
  }

  unregisterUserTool(name: string): void {
    this.agent.records.logRecord({
      type: 'tools.unregister_user_tool',
      name,
    });
    this.userTools.delete(name);
    this.enabledTools.delete(name);
    this.toolOwners.delete(name);
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'user.unregistered',
      toolName: name,
    });
  }

  /**
   * Drop every user tool owned by `ownerPluginId` (a plugin being removed,
   * disabled, or circuit-tripped). Returns the removed count. The loop rebuilds
   * its tool list from `loopTools` on the next step, so no extra refresh is
   * needed beyond the per-tool events emitted here.
   */
  unregisterToolsByOwner(ownerPluginId: string): number {
    let removed = 0;
    for (const [toolName, owner] of this.toolOwners) {
      if (owner !== ownerPluginId) continue;
      this.unregisterUserTool(toolName);
      removed += 1;
    }
    return removed;
  }

  /**
   * Circuit breaker bookkeeping (see `PLUGIN_CIRCUIT_TRIP_THRESHOLD`): every
   * plugin-owned capability outcome flows here. `ok` clears the streak; a
   * failure streak reaching the threshold trips the plugin exactly once and
   * starts its asynchronous teardown. Returns 'tripped' on the call that
   * crossed the line, so the caller can attach the advisory to its result.
   */
  reportOwnerOutcome(pluginId: string, ok: boolean): 'tripped' | undefined {
    // Usage signal first: every plugin-owned outcome feeds the keep/remove
    // statistics, success or failure alike (a failed call still counts).
    this.agent.toolServices?.plugins?.recordUsage?.(pluginId, ok);
    if (this.trippedPlugins.has(pluginId)) return undefined;
    if (ok) {
      this.circuitFailures.delete(pluginId);
      return undefined;
    }
    const failures = (this.circuitFailures.get(pluginId) ?? 0) + 1;
    this.circuitFailures.set(pluginId, failures);
    if (failures < PLUGIN_CIRCUIT_TRIP_THRESHOLD) return undefined;
    this.trippedPlugins.add(pluginId);
    void this.tripPlugin(pluginId, failures);
    return 'tripped';
  }

  getCircuitFailures(pluginId: string): number {
    return this.circuitFailures.get(pluginId) ?? 0;
  }

  isCircuitTripped(pluginId: string): boolean {
    return this.trippedPlugins.has(pluginId);
  }

  /** Clear the breaker for a plugin (ManagePlugin `reset`); it starts clean. */
  resetCircuit(pluginId: string): void {
    this.circuitFailures.delete(pluginId);
    this.trippedPlugins.delete(pluginId);
  }

  /**
   * Take a tripped plugin out of service: record why, persist it disabled,
   * then let the host's session-sync pass tear its code, tools, MCP servers,
   * and skills out of every live session. Best-effort: a teardown surprise
   * must never propagate back into the tool loop that detected the failures.
   */
  private async tripPlugin(pluginId: string, failures: number): Promise<void> {
    const services = this.agent.toolServices;
    try {
      if (services?.plugins !== undefined) {
        await services.plugins.markError(
          pluginId,
          `circuit tripped after ${String(failures)} consecutive tool failures`,
        );
        await services.plugins.setEnabled(pluginId, false);
      }
    } catch {
      // The ledger already recorded the trip; host bookkeeping is advisory.
    }
    try {
      await services?.pluginSync?.([pluginId]);
    } catch {
      // Same: the next session start skips the disabled plugin anyway.
    }
    try {
      // Immune memory: the lesson must outlive this session even if the user
      // later removes the broken plugin outright.
      await services?.plugins?.appendQuarantine(
        pluginId,
        `circuit tripped after ${String(failures)} consecutive tool failures`,
      );
    } catch {
      // Quarantine is advisory; never let it mask the breaker outcome.
    }
  }

  /**
   * Register an MCP server (and its tools). Public entry point for third-party
   * extensions to expose MCP-backed tools; built-in tooling does not use it.
   */
  registerMcpServer(
    serverName: string,
    client: MCPClient,
    tools: readonly Tool[],
    enabledTools?: ReadonlySet<string>,
    options?: { readonly mcp?: McpConnectionManager },
  ): McpServerRegistrationResult {
    this.unregisterMcpServer(serverName);
    const qualifiedNames: string[] = [];
    const collisions: McpToolCollision[] = [];
    const seenInThisCall = new Map<string, string>();
    for (const tool of tools) {
      if (enabledTools !== undefined && !enabledTools.has(tool.name)) continue;
      const qualified = qualifyMcpToolName(serverName, tool.name);
      const firstInThisCall = seenInThisCall.get(qualified);
      if (firstInThisCall !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'same_server', toolName: firstInThisCall },
        });
        continue;
      }
      const existingEntry = this.mcpTools.get(qualified);
      if (existingEntry !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'other_server', serverName: existingEntry.serverName },
        });
        continue;
      }
      seenInThisCall.set(qualified, tool.name);
      const wrapped: ExecutableTool = {
        name: qualified,
        description: tool.description,
        parameters: tool.parameters,
        resolveExecution: (args) => {
          return {
            description: tool.description,
            approvalRule: qualified,
            execute: async (context) => {
              // One outcome hook for every path (first call, reconnect
              // retry, protocol errors): the circuit ledger counts the
              // FINAL result, so a recovered retry never double-charges.
              const invoke = async (): Promise<ExecutableToolResult> => {
              // `args` has already been JSON-parsed and schema-validated by
              // the loop's preflight (`loop/tool-call.ts`), so the MCP
              // client gets a plain object directly.
              const runCall = async (targetClient: MCPClient): Promise<ExecutableToolResult> => {
                const result = await targetClient.callTool(
                  tool.name,
                  (args ?? {}) as Record<string, unknown>,
                  context.signal,
                );
                return mcpResultToExecutableOutput(result, qualified);
              };

              try {
                return await runCall(client);
              } catch (error) {
                const mcp = options?.mcp;
                if (
                  mcp === undefined ||
                  context.signal.aborted ||
                  !(isRetriableMcpCallError(error) || mcp.get(serverName)?.status !== 'connected')
                ) {
                  return {
                    isError: true,
                    output:
                      `MCP tool "${tool.name}" failed: ` +
                      (error instanceof Error ? error.message : String(error)),
                  };
                }

                try {
                  await mcp.reconnect(serverName);
                } catch {
                  // reconnect failed; fall through and report the original call error
                }

                if (context.signal.aborted) {
                  return {
                    isError: true,
                    output: `MCP tool "${tool.name}" aborted during reconnect.`,
                  };
                }

                const resolved = mcp.resolved(serverName);
                if (resolved === undefined) {
                  return {
                    isError: true,
                    output:
                      `MCP tool "${tool.name}" failed: ` +
                      (error instanceof Error ? error.message : String(error)),
                  };
                }

                try {
                  return await runCall(resolved.client);
                } catch (retryError) {
                  return {
                    isError: true,
                    output:
                      `MCP tool "${tool.name}" failed after reconnect: ` +
                      (retryError instanceof Error ? retryError.message : String(retryError)),
                  };
                }
              }
              };
              const outcome = await invoke();
              // Only plugin-owned MCP servers answer to the circuit breaker;
              // user-configured servers must never burn a breaker budget.
              const owner = pluginOwnerFromMcpServerName(serverName);
              if (owner === undefined) return outcome;
              if (this.reportOwnerOutcome(owner, outcome.isError !== true) !== 'tripped') {
                return outcome;
              }
              return {
                ...outcome,
                output: `${describeToolOutput(outcome.output)}\n\n${circuitTripNote(owner)}`,
              };
            },
          };
        },
      };
      this.mcpTools.set(qualified, { tool: wrapped, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    return { registered: qualifiedNames, collisions };
  }

  unregisterMcpServer(serverName: string): boolean {
    const existing = this.mcpToolsByServer.get(serverName);
    if (existing === undefined) return false;
    for (const qualified of existing) {
      this.mcpTools.delete(qualified);
    }
    this.mcpToolsByServer.delete(serverName);
    return true;
  }

  private handleMcpServerStatusChange(mcp: McpConnectionManager, entry: McpServerEntry): void {
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(mcp, entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(mcp, entry);
      return;
    }
    if (entry.status === 'failed') {
      this.unregisterMcpServer(entry.name);
      this.agent.emitEvent({
        type: 'tool.list.updated',
        reason: 'mcp.failed',
        serverName: entry.name,
      });
      return;
    }
    if (entry.status === 'disabled' || entry.status === 'pending') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        this.agent.emitEvent({
          type: 'tool.list.updated',
          reason: 'mcp.disconnected',
          serverName: entry.name,
        });
      }
    }
  }

  private registerNeedsAuthMcpServer(mcp: McpConnectionManager, entry: McpServerEntry): void {
    // Replace whatever tools (real or synthetic) were registered before; a
    // server flipping to needs-auth means previous tokens were invalidated.
    this.unregisterMcpServer(entry.name);
    const oauthService = mcp.oauthService;
    const serverUrl = mcp.getHttpServerUrl(entry.name);
    if (oauthService === undefined || serverUrl === undefined) {
      // Misconfiguration: a server reached needs-auth without the manager
      // owning an OAuth service or being HTTP. Treat it as a no-op so the
      // existing failure error message keeps the user informed.
      return;
    }
    const tool = createMcpAuthTool({
      serverName: entry.name,
      serverUrl,
      oauthService,
      reconnect: async () => {
        await mcp.reconnect(entry.name);
      },
    });
    this.mcpTools.set(tool.name, { tool, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    // The synthetic auth tool is now in the tool list; surface it the same way
    // a real toolset would show up so the model picks it up.
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private registerConnectedMcpServer(mcp: McpConnectionManager, entry: McpServerEntry): void {
    const resolved = mcp.resolved(entry.name);
    if (resolved === undefined) return;
    const result = this.registerMcpServer(
      entry.name,
      resolved.client,
      resolved.tools,
      resolved.enabledNames,
      { mcp },
    );
    this.emitMcpToolCollisions(entry.name, result.collisions);
    this.agent.emitEvent({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
  }

  private emitMcpToolCollisions(serverName: string, collisions: readonly McpToolCollision[]): void {
    if (collisions.length === 0) return;
    const summary = collisions
      .map((c) =>
        c.collidesWith.kind === 'same_server'
          ? `"${c.toolName}" -> ${c.qualified} (collides with "${c.collidesWith.toolName}" from the same server)`
          : `"${c.toolName}" -> ${c.qualified} (collides with server "${c.collidesWith.serverName}")`,
      )
      .join('; ');
    this.agent.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        'mcp.tool_name_collision',
        `MCP server "${serverName}" registered ${collisions.length} tool name` +
          `${collisions.length === 1 ? '' : 's'} ` +
          `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
        { details: { serverName, collisions: collisions as readonly unknown[] } },
      ),
    });
  }

  getActiveTools(): readonly string[] {
    // Include MCP glob patterns: they are stored separately from exact-name
    // tools, but they ARE part of the active set. A get → set round-trip
    // (model switching via /rlm) must not silently drop MCP tools.
    return [...this.enabledTools, ...this.mcpAccessPatterns];
  }

  getBuiltinTool(name: string): BuiltinTool | undefined {
    return this.builtinTools.get(name);
  }

  setActiveTools(names: readonly string[]): void {
    this.agent.records.logRecord({
      type: 'tools.set_active_tools',
      names,
    });
    // MCP entries are glob patterns gated separately; the rest are exact
    // builtin/user tool names. The split keeps every caller on one string[].
    this.enabledTools = new Set(names.filter((name) => !isMcpToolName(name)));
    this.mcpAccessPatterns = names.filter((name) => isMcpToolName(name));
  }

  private isMcpToolEnabled(name: string): boolean {
    return this.mcpAccessPatterns.some((pattern) => picomatch.isMatch(name, pattern));
  }

  /** The enabled-name filter a turn freezes at its start. */
  snapshotEnabledTools(): { names: ReadonlySet<string>; mcpPatterns: readonly string[] } {
    return { names: new Set(this.enabledTools), mcpPatterns: [...this.mcpAccessPatterns] };
  }

  /**
   * Build the offered tool table against an explicit enabled-name filter
   * while the registration maps (user tools, MCP servers) stay live. A turn
   * uses this with its frozen filter: a mid-turn `setActiveTools` then
   * applies to the NEXT turn by design (turn config stability), while a
   * plugin tool registered — or reclaimed by the breaker — mid-turn still
   * shows up on the very next step.
   */
  loopToolsFor(filter: {
    names: ReadonlySet<string>;
    mcpPatterns: readonly string[];
  }): readonly ExecutableTool[] {
    const mcpNames = [...this.mcpTools.keys()].filter((name) =>
      filter.mcpPatterns.some((pattern) => picomatch.isMatch(name, pattern)),
    );
    // Mutation goal tools are only offered to the model while a goal exists.
    const hideGoalMutationTools = this.agent.goal.getGoal().goal === null;
    return uniq([...filter.names, ...mcpNames])
      .toSorted((a, b) => a.localeCompare(b))
      .filter(
        (name) =>
          !(hideGoalMutationTools && (name === 'SetGoalBudget' || name === 'UpdateGoal' || name === 'WriteGoalNote')),
      )
      .map(
        (name) =>
          this.userTools.get(name) ??
          this.mcpTools.get(name)?.tool ??
          this.builtinTools.get(name),
      )
      .filter((tool) => !!tool);
  }

  *toolInfos(): Iterable<ToolInfo> {
    for (const tool of this.builtinTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: 'builtin',
      };
    }
    for (const tool of this.userTools.values()) {
      yield {
        name: tool.name,
        description: tool.description,
        active: this.enabledTools.has(tool.name),
        source: 'user',
      };
    }
    for (const entry of this.mcpTools.values()) {
      yield {
        name: entry.tool.name,
        description: entry.tool.description,
        active: this.isMcpToolEnabled(entry.tool.name),
        source: 'mcp',
      };
    }
  }

  data(): readonly ToolInfo[] {
    return Array.from(this.toolInfos());
  }

  storeData(): Readonly<Record<string, unknown>> {
    return { ...this.store };
  }

  initializeBuiltinTools() {
    const {
      jian,
      toolServices,
      config: { cwd, provider, modelCapabilities },
      background,
    } = this.agent;
    const videoUploader = this.createVideoUploader(provider);
    const workspace = extendWorkspaceWithSkillRoots(
      {
        workspaceDir: cwd,
        additionalDirs: [],
      },
      this.agent.skills?.registry.getSkillRoots() ?? [],
    );
    // Reuse the existing registry when this agent's jian is unchanged: config
    // refreshes / skills reloads call initializeBuiltinTools repeatedly, and
    // rebuilding the registry here would orphan every live LSP server.
    if (this.lspRegistry === undefined || this.lspRegistryJian !== jian) {
      this.lspRegistry = new LspRegistry(jian, this.agent.lspSupervisor);
      this.lspRegistryJian = jian;
    }
    const allowBackground =
      this.enabledTools.has('TaskList') &&
      this.enabledTools.has('TaskOutput') &&
      this.enabledTools.has('TaskStop');
    // Collaboration tools. Main agents see all configured subagents.
    // Subagents with a `spawns` whitelist in their profile can spawn only
    // the listed profiles; this lets plan/reviewer recursively delegate
    // parallel exploration without giving every subagent full spawn power.
    const parentProfile = DEFAULT_AGENT_PROFILES[this.agent.config.profileName ?? 'agent'];
    const allowedSpawns = parentProfile?.spawns;
    const canSpawn =
      this.agent.subagentHost &&
      (this.agent.type !== 'sub' || (allowedSpawns !== undefined && allowedSpawns.length > 0));
    const visibleSubagents = allowedSpawns
      ? Object.fromEntries(
          Object.entries(DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {}).filter(([name]) =>
            allowedSpawns.includes(name),
          ),
        )
      : DEFAULT_AGENT_PROFILES['agent']?.subagents;

    this.builtinTools = new Map(
      [
        new b.ReadTool(jian, workspace),
        new b.ReadGroupTool(jian, workspace),
        new b.WriteTool(jian, workspace, this.lspRegistry),
        new b.EditTool(jian, workspace, this.lspRegistry),
        new b.GrepTool(jian, workspace),
        new b.GlobTool(jian, workspace),
        new b.BashTool(jian, cwd, background, {
          allowBackground,
          availableTools: this.enabledTools,
        }),
        // /rlm mode: persistent python kernel. Registered but NOT enabled by
        // default — activated only when the /rlm command adds 'python' to the
        // active tools (setActiveTools), so default behaviour is unchanged.
        // Host handlers are ALWAYS passed so the kernel bootstrap always
        // defines rlm()/rlm_wait() — the handler body checks subagentHost at
        // call time (never at construction), so rlm() never NameErrors.
        new b.PythonTool(cwd, { hostHandlers: createRlmHostHandlers(this.agent) }),
        (modelCapabilities.image_in || modelCapabilities.video_in) &&
          new b.ReadMediaFileTool(jian, workspace, modelCapabilities, videoUploader),
        new b.EnterPlanModeTool(this.agent),
        new b.ExitPlanModeTool(this.agent),
        this.agent.rpc?.requestQuestion && new b.AskUserQuestionTool(this.agent),
        new b.TodoListTool(this.toolStore),
        new b.TaskListTool(background),
        new b.TaskOutputTool(background),
        new b.TaskStopTool(background),
        new b.ReportFindingTool(this.toolStore),
        this.agent.cron && new b.CronCreateTool(this.agent.cron),
        this.agent.cron && new b.CronListTool(this.agent.cron),
        this.agent.cron && new b.CronDeleteTool(this.agent.cron),
        // Goal tools are main-agent-only.
        this.agent.type === 'main' && new b.CreateGoalTool(this.agent),
        this.agent.type === 'main' && new b.UpdateGoalTool(this.agent, createGoalGrader(this.agent)),
        this.agent.type === 'main' && new b.GetGoalTool(this.agent),
        this.agent.type === 'main' && new b.SetGoalBudgetTool(this.agent),
        this.agent.type === 'main' && new b.WriteGoalNoteTool(this.agent),
        // Memory tools are main-agent-only because the store is global.
        this.agent.type === 'main' && this.agent.memoStore && new b.MemoryLookupTool(this.agent),
        this.agent.type === 'main' && this.agent.memoStore && new b.MemoryEditTool(this.agent),
        this.agent.type === 'main' && this.agent.memoStore && new b.MemoryConsolidatePlanTool(this.agent),
        this.agent.type === 'main' && this.agent.memoStore && new b.MemoryConsolidateApplyTool(this.agent),
        this.agent.type === 'main' && this.agent.memoStore && new b.MemoryWriteTool(this.agent),
        this.agent.type === 'main' && this.agent.knowledgeStore && new b.KnowledgeLookupTool(this.agent),
        // Inspecting own assets is a main-agent concern.
        this.agent.type === 'main' && new b.InspectOwnAssetsTool(this.agent),
        this.agent.skills?.registry.listInvocableSkills().length &&
          new b.SkillTool(this.agent),
        this.agent.type === 'main' && new b.MakeSkillPlanTool(this.agent),
        this.agent.type === 'main' && new b.MakeSkillApplyTool(this.agent),
        // Managing the plugin center is a main-agent concern: it mutates the
        // process-wide plugin table and can activate code, so subagents never
        // get the handle.
        this.agent.type === 'main' && new b.ManagePluginTool(this.agent),
        canSpawn &&
          new b.AgentTool(
            this.agent.subagentHost,
            background,
            visibleSubagents,
            {
              allowBackground,
              log: this.agent.log,
              allowedSpawns,
            },
          ),
        canSpawn && new b.SendSubagentMessageTool(this.agent.subagentHost),
        canSpawn &&
          new b.WolfPackTool(
            this.agent.subagentHost,
            () => this.agent.wolfpackMode.isActive,
            {
              subagents: visibleSubagents,
              log: this.agent.log,
              allowedSpawns,
            },
          ),
        // FusionPlan is main-agent-only because it enters plan mode and writes
        // the plan file; subagents should never recursively invoke it.
        this.agent.type === 'main' && canSpawn && new b.FusionPlanTool(this.agent),

        toolServices?.webSearcher && new b.WebSearchTool(toolServices.webSearcher),
        toolServices?.urlFetcher && new b.FetchURLTool(toolServices.urlFetcher),
        this.lspRegistry && new LspTool(this.agent, workspace, this.lspRegistry),
      ]
        .filter((tool) => !!tool)
        .map((tool) => [tool.name, tool] as const),
    );
  }

  /**
   * Stop every LSP server this agent started and forget the registry. Called
   * from session close (and error paths); idempotent.
   */
  async disposeLsp(): Promise<void> {
    const registry = this.lspRegistry;
    this.lspRegistry = undefined;
    this.lspRegistryJian = undefined;
    if (registry !== undefined) {
      await registry.stopAll();
    }
  }

  private createVideoUploader(provider: ChatProvider): b.VideoUploader | undefined {
    const uploadVideo = provider.uploadVideo?.bind(provider);
    if (uploadVideo === undefined) return undefined;

    const modelAlias = this.agent.config.modelAlias!;
    const withAuth = this.agent.modelProvider?.resolveAuth?.(modelAlias, {
      log: this.agent.log,
    });
    if (withAuth === undefined) return (input) => uploadVideo(input);
    return (input) => withAuth((auth) => uploadVideo(input, { auth }));
  }

  get loopTools(): readonly ExecutableTool[] {
    return this.loopToolsFor({
      names: this.enabledTools,
      mcpPatterns: this.mcpAccessPatterns,
    });
  }
}
