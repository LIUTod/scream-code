/**
 * DiscoverToolsTool — the deferred built-in tool portal, plus the static
 * table of deferred groups it fronts.
 *
 * Why this exists: every declared tool costs its JSON schema on every model
 * request (see `discover-mcp-tools.ts` for the MCP-side version of the same
 * argument). Eight low-frequency built-in groups — cron, memory, knowledge,
 * goal, image, make-skill, manage-plugin, inspect — are removed from the
 * default tool table (about 19 schemas) and offered through this one portal
 * tool instead. A group's tools are NOT constructed while deferred; enabling
 * a group constructs its instances and puts their names into the enabled
 * set, so they are callable from the model's next turn (the turn loop
 * freezes the enabled-name filter at turn start — see agent/turn/index.ts).
 *
 * `loopControl.toolPortal: 'off'` in the config restores the pre-portal
 * behavior byte-for-byte: the group tools are constructed eagerly by the
 * registry and the portal tool does not exist.
 *
 * The group table is name-only by design: it never holds tool instances, so
 * importing it is side-effect free and the portal's description (built from
 * the table at module load) stays byte-stable across sessions, keeping the
 * provider prefix cacheable.
 */

import type { Jian } from '@scream-code/jian';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool, ToolManager } from '#/agent/tool';

import { CronCreateTool } from '../cron/cron-create';
import { CronDeleteTool } from '../cron/cron-delete';
import { CronListTool } from '../cron/cron-list';
import type { WorkspaceConfig } from '../support/workspace';
import { toInputJsonSchema } from '../support/input-schema';
import { CreateGoalTool } from './goal/create-goal';
import { GetGoalTool } from './goal/get-goal';
import { SetGoalBudgetTool } from './goal/set-goal-budget';
import type { GoalGraderFn } from './goal/update-goal';
import { UpdateGoalTool } from './goal/update-goal';
import { WriteGoalNoteTool } from './goal/write-goal-note';
import { ImageGenerateTool } from './image/image-generate';
import { KnowledgeLookupTool } from './knowledge/knowledge-lookup';
import {
  MemoryConsolidateApplyTool,
  MemoryConsolidatePlanTool,
} from './memory/memory-consolidate';
import { MemoryEditTool } from './memory/memory-edit';
import { MemoryLookupTool } from './memory/memory-lookup';
import { MemoryWriteTool } from './memory/memory-write';
import { ManagePluginTool } from './plugin/manage-plugin';
import { MakeSkillApplyTool } from './skill/make-skill-apply';
import { MakeSkillPlanTool } from './skill/make-skill-plan';
import { InspectOwnAssetsTool } from './state/inspect-own-assets';

// ── Group table ──────────────────────────────────────────────────────

/** Name of the portal tool that fronts the deferred groups. */
export const DEFERRED_PORTAL_TOOL_NAME = 'DiscoverTools';

/**
 * Group names the portal accepts, in the order the description lists them.
 * The portal's input schema is derived from this tuple, so adding a group is
 * a one-place change plus its factory below.
 */
export const DEFAULT_DEFERRED_GROUP_NAMES = [
  'cron',
  'memory',
  'knowledge',
  'goal',
  'image',
  'make-skill',
  'manage-plugin',
  'inspect',
] as const;

export type DeferredToolGroupName = (typeof DEFAULT_DEFERRED_GROUP_NAMES)[number];

/**
 * Everything a group factory needs to build its tools. Mirrors the
 * construction arguments the registry used to pass inline, plus the goal
 * grader (the one constructor argument that is itself built from the
 * agent). The registry only invokes factories for main agents and only when
 * the portal is active — the `type === 'main'` construction gates these
 * factories reproduce live in the registry, not here.
 */
export interface DeferredToolGroupContext {
  readonly agent: Agent;
  readonly jian: Jian;
  readonly cwd: string;
  readonly workspace: WorkspaceConfig;
  /** Shared grader for the goal group's UpdateGoal tool. */
  readonly goalGrader: GoalGraderFn;
}

export interface DeferredToolGroup {
  readonly name: DeferredToolGroupName;
  /** Exact tool names the group contributes; the portal description and
   * the enable result both render this list. */
  readonly toolNames: readonly string[];
  /**
   * Build the group's tools. Returns only the tools whose backing runtime
   * exists (a group can be empty when its store is not configured — e.g.
   * `memory` without a memo store); the registry treats an empty result as
   * "nothing to enable" and refuses instead of pretending success.
   */
  construct(context: DeferredToolGroupContext): readonly BuiltinTool[];
}

/**
 * The deferred groups, in the order the portal description lists them.
 * Conditions inside each factory are the exact construction gates the
 * registry applied before the portal existed — keep them in sync with
 * `agent/tool/index.ts` when adding a tool.
 */
export const DEFERRED_GROUPS: readonly DeferredToolGroup[] = [
  {
    name: 'cron',
    toolNames: ['CronCreate', 'CronList', 'CronDelete'],
    construct: (context) =>
      context.agent.cron
        ? [
            new CronCreateTool(context.agent.cron),
            new CronListTool(context.agent.cron),
            new CronDeleteTool(context.agent.cron),
          ]
        : [],
  },
  {
    name: 'memory',
    toolNames: [
      'MemoryLookup',
      'MemoryEdit',
      'MemoryWrite',
      'MemoryConsolidatePlan',
      'MemoryConsolidateApply',
    ],
    construct: (context) =>
      context.agent.memoStore === undefined
        ? []
        : [
            new MemoryLookupTool(context.agent),
            new MemoryEditTool(context.agent),
            new MemoryWriteTool(context.agent),
            new MemoryConsolidatePlanTool(context.agent),
            new MemoryConsolidateApplyTool(context.agent),
          ],
  },
  {
    name: 'knowledge',
    toolNames: ['KnowledgeLookup'],
    construct: (context) =>
      context.agent.knowledgeStore === undefined ? [] : [new KnowledgeLookupTool(context.agent)],
  },
  {
    name: 'goal',
    toolNames: ['CreateGoal', 'GetGoal', 'UpdateGoal', 'SetGoalBudget', 'WriteGoalNote'],
    construct: (context) => [
      new CreateGoalTool(context.agent),
      new GetGoalTool(context.agent),
      new UpdateGoalTool(context.agent, context.goalGrader),
      new SetGoalBudgetTool(context.agent),
      new WriteGoalNoteTool(context.agent),
    ],
  },
  {
    name: 'image',
    toolNames: ['ImageGenerate'],
    construct: (context) =>
      context.agent.screamHomeDir === undefined
        ? []
        : [
            new ImageGenerateTool(
              context.cwd,
              context.agent.screamHomeDir,
              context.jian,
              context.workspace,
            ),
          ],
  },
  {
    name: 'make-skill',
    toolNames: ['MakeSkillPlan', 'MakeSkillApply'],
    construct: (context) => [new MakeSkillPlanTool(context.agent), new MakeSkillApplyTool(context.agent)],
  },
  {
    name: 'manage-plugin',
    toolNames: ['ManagePlugin'],
    construct: (context) => [new ManagePluginTool(context.agent)],
  },
  {
    name: 'inspect',
    toolNames: ['InspectOwnAssets'],
    construct: (context) => [new InspectOwnAssetsTool(context.agent)],
  },
];

/** Group by its portal-level name. */
export function getDeferredGroup(name: string): DeferredToolGroup | undefined {
  return DEFERRED_GROUPS.find((group) => group.name === name);
}

/** Tool name → owning group; drives the registry's deferral filter. */
const DEFERRED_TOOL_NAME_INDEX: ReadonlyMap<string, DeferredToolGroup> = new Map(
  DEFERRED_GROUPS.flatMap((group) => group.toolNames.map((toolName) => [toolName, group] as const)),
);

/** True while a built-in tool name belongs to a deferred group. */
export function isDeferredBuiltinToolName(name: string): boolean {
  return DEFERRED_TOOL_NAME_INDEX.has(name);
}

/** The group a deferred tool name belongs to (undefined for other names). */
export function getDeferredGroupByToolName(name: string): DeferredToolGroup | undefined {
  return DEFERRED_TOOL_NAME_INDEX.get(name);
}

// ── Portal tool ──────────────────────────────────────────────────────

export const DiscoverToolsInputSchema = z
  .object({
    group: z.enum([...DEFAULT_DEFERRED_GROUP_NAMES]).describe('Tool group to enable.'),
  })
  .strict();
export type DiscoverToolsInput = z.infer<typeof DiscoverToolsInputSchema>;

function buildDeferredGroupsDescription(): string {
  return DEFERRED_GROUPS.map((group) => `${group.name} (${group.toolNames.join(', ')})`).join('; ');
}

/**
 * What the registry reports back for one enable request. The portal tool
 * renders these statuses into its result; the registry owns the state
 * transitions behind them.
 */
export type DeferredGroupEnableResult =
  | { readonly status: 'enabled'; readonly toolNames: readonly string[] }
  | { readonly status: 'already-enabled' }
  | { readonly status: 'unavailable'; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

export class DiscoverToolsTool implements BuiltinTool<DiscoverToolsInput> {
  readonly name: string = DEFERRED_PORTAL_TOOL_NAME;
  readonly description =
    'Enable built-in tool groups that are not declared by default: their schemas stay out of ' +
    'every request until you enable one here (the built-in counterpart of DiscoverMcpTools). ' +
    `Groups: ${buildDeferredGroupsDescription()}. ` +
    'Call with { group } to enable one for this session — its tools are constructed and ' +
    'available from your next turn. Enabling is idempotent.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DiscoverToolsInputSchema);

  constructor(private readonly tools: ToolManager) {}

  resolveExecution(args: DiscoverToolsInput) {
    return {
      description: `Enabling tool group: ${args.group}`,
      approvalRule: this.name,
      execute: async () => {
        const result = this.tools.enableDeferredToolGroup(args.group);
        if (result.status === 'enabled') {
          return {
            output: `Enabled ${args.group}: ${result.toolNames.join(', ')}. They are available from your next turn.`,
            isError: false as const,
          };
        }
        if (result.status === 'already-enabled') {
          return {
            output: `Group '${args.group}' is already enabled.`,
            isError: false as const,
          };
        }
        return { output: result.message, isError: true as const };
      },
    };
  }
}
