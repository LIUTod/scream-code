import { uniq } from '@antfu/utils';
import type { ChatProvider, Tool } from '@scream-code/ltod';
import picomatch from 'picomatch';

import type { Agent } from '..';
import { makeErrorPayload } from '../../errors';
import type { ExecutableTool, ExecutableToolResult } from '../../loop';
import { createMcpAuthTool } from '../../mcp/auth-tool';
import { isRetriableMcpCallError } from '../../mcp/client-shared';
import type { McpConnectionManager, McpServerEntry } from '../../mcp';
import { mcpResultToExecutableOutput } from '../../mcp/output';
import { isMcpToolName, qualifyMcpToolName } from '../../mcp/tool-naming';
import type { MCPClient } from '../../mcp/types';
import { DEFAULT_AGENT_PROFILES } from '../../profile';
import { extendWorkspaceWithSkillRoots } from '../../skill';
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
    if (!match) return { pass: true, reason: 'No JSON found in grader response', summary: '' };
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
    return { pass: true, reason: 'Failed to parse grader response', summary: '' };
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

export class ToolManager {
  protected builtinTools: Map<string, BuiltinTool> = new Map();
  protected readonly userTools: Map<string, ExecutableTool> = new Map();
  protected readonly mcpTools: Map<string, McpToolEntry> = new Map();
  /** server name → list of qualified tool names registered for that server. */
  protected readonly mcpToolsByServer: Map<string, string[]> = new Map();
  protected enabledTools: Set<string> = new Set();
  /** Glob patterns (e.g. `mcp__*`, `mcp__github__*`) gating which MCP tools the profile exposes. */
  private mcpAccessPatterns: string[] = [];
  protected readonly store: Partial<ToolStoreData> = {};
  private mcpToolStatusUnsubscribe: (() => void) | undefined;
  private lspRegistry: LspRegistry | undefined;

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
    this.agent.records.logRecord({
      type: 'tools.update_store',
      key,
      value,
    });
    this.store[key] = value;
  }

  registerUserTool(input: UserToolRegistration): void {
    this.agent.records.logRecord({
      type: 'tools.register_user_tool',
      ...input,
    });
    const { name, description, parameters } = input;
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => {
        return {
          description,
          approvalRule: name,
          execute: async (context) => {
            return this.agent.rpc!.toolCall!(
              {
                turnId: Number(context.turnId),
                toolCallId: context.toolCallId,
                args,
              },
              { signal: context.signal },
            );
          },
        };
      },
    };
    this.userTools.set(name, tool);
    this.enabledTools.add(name);
  }

  unregisterUserTool(name: string): void {
    this.agent.records.logRecord({
      type: 'tools.unregister_user_tool',
      name,
    });
    this.userTools.delete(name);
    this.enabledTools.delete(name);
  }

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
    this.lspRegistry = new LspRegistry(this.agent.jian);
    const allowBackground =
      this.enabledTools.has('TaskList') &&
      this.enabledTools.has('TaskOutput') &&
      this.enabledTools.has('TaskStop');
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
        this.agent.skills?.registry.listInvocableSkills().length &&
          new b.SkillTool(this.agent),
        this.agent.type === 'main' && new b.MakeSkillPlanTool(this.agent),
        this.agent.type === 'main' && new b.MakeSkillApplyTool(this.agent),
        this.agent.subagentHost &&
          this.agent.type !== 'sub' &&
          new b.AgentTool(
            this.agent.subagentHost,
            background,
            DEFAULT_AGENT_PROFILES['agent']?.subagents,
            {
              allowBackground,
              log: this.agent.log,
            },
          ),
        this.agent.subagentHost &&
          this.agent.type !== 'sub' &&
          new b.WolfPackTool(
            this.agent.subagentHost,
            () => this.agent.wolfpackMode.isActive,
            {
              subagents: DEFAULT_AGENT_PROFILES['agent']?.subagents,
              log: this.agent.log,
            },
          ),

        toolServices?.webSearcher && new b.WebSearchTool(toolServices.webSearcher),
        toolServices?.urlFetcher && new b.FetchURLTool(toolServices.urlFetcher),
        this.lspRegistry && new LspTool(this.agent, workspace, this.lspRegistry),
      ]
        .filter((tool) => !!tool)
        .map((tool) => [tool.name, tool] as const),
    );
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
    const mcpNames = [...this.mcpTools.keys()].filter((name) => this.isMcpToolEnabled(name));
    // Mutation goal tools are only offered to the model while a goal exists.
    const hideGoalMutationTools = this.agent.goal.getGoal().goal === null;
    return uniq([...this.enabledTools, ...mcpNames])
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
}
