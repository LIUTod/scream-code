/**
 * Deferred tool portal (DiscoverTools).
 *
 * Eight low-frequency built-in groups stay out of the default tool table;
 * the portal tool fronts them: enabling a group constructs its instances,
 * puts their names into the enabled set, and the turn loop's frozen
 * enabled-name filter turns that into next-turn availability.
 * `loopControl.toolPortal: 'off'` restores the pre-portal registry
 * byte-for-byte — the "off" assertions below pin that contract.
 */

import type { Jian } from '@scream-code/jian';
import { describe, expect, it } from 'vitest';

import { toolDeclarationsFingerprint } from '../../src/agent/context/prefix-fingerprint';
import type { Agent } from '../../src/agent';
import type { ToolManager } from '../../src/agent/tool';
import {
  DEFERRED_GROUPS,
  DEFAULT_DEFERRED_GROUP_NAMES,
  DEFERRED_PORTAL_TOOL_NAME,
  DiscoverToolsInputSchema,
  DiscoverToolsTool,
  getDeferredGroup,
} from '../../src/tools/builtin/deferred-tools';
import type { DeferredToolGroupContext } from '../../src/tools/builtin/deferred-tools';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { harnessConfig, testAgent, type AgentTestContext } from '../agent/harness/agent';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function portalContext(args: { group: string }) {
  return { turnId: '0', toolCallId: 'call_portal', args, signal };
}

function stubGoalGrader() {
  return async () => ({ pass: true, reason: '', issues: [], summary: '' });
}

/** Group-table stub: every backing runtime present, construction only. */
function fullContext(): DeferredToolGroupContext {
  return {
    agent: {
      cron: {},
      memoStore: {},
      knowledgeStore: {},
      screamHomeDir: '/scream-home',
      type: 'main',
    } as unknown as Agent,
    jian: {} as unknown as Jian,
    cwd: '/workspace',
    workspace: { workspaceDir: '/workspace', additionalDirs: [] } satisfies WorkspaceConfig,
    goalGrader: stubGoalGrader(),
  };
}

/** Registry-level harness agent in default (portal-on) mode. */
function portalCtx(): { ctx: AgentTestContext; tools: ToolManager } {
  // `configure()` builds the registry; `applyDefaultProfile()` puts the
  // DEFAULT resolved tool set in place — the only shape the portal applies
  // to (an explicit `tools:` list is an exact contract, see setActiveTools).
  const ctx = testAgent();
  ctx.configure();
  ctx.applyDefaultProfile();
  return { ctx, tools: ctx.agent.tools };
}

function offered(tools: ToolManager): string[] {
  return tools.loopTools.map((tool) => tool.name);
}

async function callPortal(tools: ToolManager, group: string) {
  const portal = tools.getBuiltinTool('DiscoverTools');
  expect(portal, 'portal tool must be constructed in default mode').toBeDefined();
  return executeTool(portal!, portalContext({ group }));
}

describe('deferred group table', () => {
  it('lists the default groups in the documented order', () => {
    expect(DEFERRED_GROUPS.map((group) => group.name)).toEqual([
      'cron',
      'memory',
      'knowledge',
      'goal',
      'image',
      'make-skill',
      'manage-plugin',
      'inspect',
    ]);
    expect(DEFERRED_GROUPS.length).toBe(DEFAULT_DEFERRED_GROUP_NAMES.length);
  });

  it('every group constructs exactly the tool names it declares', () => {
    for (const group of DEFERRED_GROUPS) {
      const tools = group.construct(fullContext());
      expect(tools.map((tool) => tool.name), group.name).toEqual([...group.toolNames]);
      // Every constructed tool must carry a schema — it joins the tool
      // table verbatim once enabled.
      for (const tool of tools) {
        expect(typeof tool.description, tool.name).toBe('string');
        expect(tool.parameters, tool.name).toBeTypeOf('object');
      }
    }
  });

  it('groups whose backing runtime is absent construct nothing', () => {
    const bareContext: DeferredToolGroupContext = {
      agent: { type: 'main' } as unknown as Agent,
      jian: {} as unknown as Jian,
      cwd: '/workspace',
      workspace: { workspaceDir: '/workspace', additionalDirs: [] } satisfies WorkspaceConfig,
      goalGrader: stubGoalGrader(),
    };
    expect(getDeferredGroup('cron')?.construct(bareContext).map((t) => t.name)).toEqual([]);
    expect(getDeferredGroup('memory')?.construct(bareContext).map((t) => t.name)).toEqual([]);
    expect(getDeferredGroup('knowledge')?.construct(bareContext).map((t) => t.name)).toEqual([]);
    expect(getDeferredGroup('image')?.construct(bareContext).map((t) => t.name)).toEqual([]);
    // These four never depended on a store.
    expect(getDeferredGroup('goal')?.construct(bareContext).map((t) => t.name)).toEqual([
      'CreateGoal',
      'GetGoal',
      'UpdateGoal',
      'SetGoalBudget',
      'WriteGoalNote',
    ]);
    expect(getDeferredGroup('inspect')?.construct(bareContext).map((t) => t.name)).toEqual([
      'InspectOwnAssets',
    ]);
  });
});

describe('DiscoverTools portal tool', () => {
  it('description lists every deferred group with its tool names', () => {
    const tool = new DiscoverToolsTool({} as ToolManager);
    for (const group of DEFERRED_GROUPS) {
      expect(tool.description).toContain(group.name);
      for (const name of group.toolNames) {
        expect(tool.description, name).toContain(name);
      }
    }
  });

  it('input schema rejects unknown group names', () => {
    expect(DiscoverToolsInputSchema.safeParse({ group: 'cron' }).success).toBe(true);
    expect(DiscoverToolsInputSchema.safeParse({ group: 'everything' }).success).toBe(false);
    expect(DiscoverToolsInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('tool portal in the registry (default mode)', () => {
  it('holds the deferred groups back and offers the portal instead', () => {
    const { ctx, tools } = portalCtx();
    const names = offered(tools);
    for (const group of DEFERRED_GROUPS) {
      for (const name of group.toolNames) {
        expect(names, name).not.toContain(name);
      }
    }
    expect(names).toContain(DEFERRED_PORTAL_TOOL_NAME);
    expect(names).toContain('Bash');
    // Everything else offered is the ordinary default set — the portal is
    // the only name added, and no deferred name leaks in.
    expect(names).toContain('Read');
    expect(names).toContain('Edit');
    // Not constructed either: nothing to execute behind the withheld names.
    expect(tools.getBuiltinTool('CronCreate')).toBeUndefined();
    expect(tools.getBuiltinTool('MemoryLookup')).toBeUndefined();
    // The wired name is the same set the profile application produced.
    const active = ctx.agent.tools.getActiveTools();
    for (const group of DEFERRED_GROUPS) {
      for (const name of group.toolNames) {
        expect(active, name).not.toContain(name);
      }
    }
    expect(active).toContain(DEFERRED_PORTAL_TOOL_NAME);
  });

  /**
   * Regression net for the contract split: `setActiveTools` is EXACT (SDK
   * callers, explicit `tools:` profiles, /script//rlm toggles), while the
   * DEFAULT profile application is the one path the portal shapes. Before
   * this split, shaping lived in `setActiveTools` and reshaped explicit
   * lists; after moving it into `useProfile`, a default profile that skipped
   * it would lose the portal entirely.
   */
  it('applies an explicit active list exactly and shapes the default profile', () => {
    const ctx = testAgent();
    ctx.configure();
    const tools = ctx.agent.tools;

    // Explicit list: exactly what was asked for — no portal, no holding.
    tools.setActiveTools(['Read', 'Edit', 'Bash', 'CronCreate']);
    expect([...tools.getActiveTools()]).toEqual(['Read', 'Edit', 'Bash', 'CronCreate']);
    expect(offered(tools)).not.toContain(DEFERRED_PORTAL_TOOL_NAME);

    // Same registry, default-profile application: deferred name withheld,
    // portal offered, ordinary tools untouched.
    ctx.applyDefaultProfile();
    const active = tools.getActiveTools();
    expect(active).toContain(DEFERRED_PORTAL_TOOL_NAME);
    for (const group of DEFERRED_GROUPS) {
      for (const name of group.toolNames) {
        expect(active, name).not.toContain(name);
      }
    }
    for (const name of ['Read', 'Edit', 'Bash']) expect(active, name).toContain(name);
    // The helper's explicit `CronCreate` is gone with the old list.
    expect(offered(tools)).not.toContain('CronCreate');
    expect(offered(tools)).toContain(DEFERRED_PORTAL_TOOL_NAME);
  });

  it('keeps a group enabled earlier in the session when the default profile is re-applied', () => {
    const { ctx, tools } = portalCtx();
    expect(tools.enableDeferredToolGroup('cron').status).toBe('enabled');
    expect(tools.getActiveTools()).toContain('CronCreate');

    // Profile re-application (config refresh / skills reload / resume) must
    // put the enabled group's names back instead of reverting to the plain
    // default set.
    ctx.applyDefaultProfile();

    const active = tools.getActiveTools();
    for (const name of getDeferredGroup('cron')?.toolNames ?? []) {
      expect(active, name).toContain(name);
      expect(tools.getBuiltinTool(name), name).toBeDefined();
    }
    expect(active).toContain(DEFERRED_PORTAL_TOOL_NAME);
    // Groups nobody enabled stay withheld.
    expect(active).not.toContain('CreateGoal');
  });

  it('applies an explicit profile tool list verbatim, including a deferred name', () => {
    const ctx = testAgent();
    ctx.configure();

    // Cron, not memory: the harness has no memo store, so the memory group
    // constructs nothing either way. The cron group only needs the main
    // agent's cron manager, which makes "the instance exists" a real
    // assertion rather than a comment.
    ctx.agent.useProfile({
      name: 'explicit-bot',
      systemPrompt: () => 'explicit profile prompt',
      tools: ['Bash', 'CronCreate'],
      toolsExplicit: true,
    });

    const active = ctx.agent.tools.getActiveTools();
    // Exactly the profile's list: the deferred name is enabled directly, no
    // group holding and no portal entry.
    expect([...active]).toEqual(['Bash', 'CronCreate']);
    expect(active).not.toContain(DEFERRED_PORTAL_TOOL_NAME);
    // And it must actually be constructed: the portal gate skips deferred
    // groups in the base pass, so the name alone used to be dropped by
    // loopToolsFor — neither the tool nor the portal reached the model.
    expect(ctx.agent.tools.loopTools.map((tool) => tool.name)).toContain('CronCreate');
    expect(ctx.agent.tools.getBuiltinTool('CronCreate')).toBeDefined();
    // Exact means exact: the group's sibling names are not switched on.
    expect(active).not.toContain('CronList');
    expect(ctx.agent.tools.loopTools.map((tool) => tool.name)).not.toContain('CronList');
    // A registry rebuild (config refresh / skills reload / MCP connect) must
    // not orphan the instance: the enabled name has to survive the fresh map.
    ctx.agent.tools.initializeBuiltinTools();
    expect(ctx.agent.tools.loopTools.map((tool) => tool.name)).toContain('CronCreate');
    expect([...ctx.agent.tools.getActiveTools()]).toEqual(['Bash', 'CronCreate']);
  });

  it('constructs a deferred name set through the SDK active-tool path', async () => {
    // `session.setActiveTools` → rpc → the agent's handler; it never passes
    // through `useProfile`, so the registry needs the same post-set
    // construction step there or the name is silently inert.
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.setActiveTools({ names: ['Bash', 'CronCreate'] });

    expect([...ctx.agent.tools.getActiveTools()]).toEqual(['Bash', 'CronCreate']);
    expect(ctx.agent.tools.loopTools.map((tool) => tool.name)).toContain('CronCreate');
  });

  it('enabling a group constructs its tools and offers them', async () => {
    const { tools } = portalCtx();
    const before = offered(tools);
    const result = await callPortal(tools, 'cron');
    expect(result.isError).toBe(false);
    expect(result.output).toBe(
      'Enabled cron: CronCreate, CronList, CronDelete. They are available from your next turn.',
    );
    expect(tools.getBuiltinTool('CronCreate')).toBeDefined();
    expect(offered(tools)).toEqual(
      [...before, 'CronCreate', 'CronDelete', 'CronList'].toSorted(),
    );
    expect(tools.data().find((info) => info.name === 'CronCreate')?.active).toBe(true);
  });

  it('a frozen turn filter keeps the enable on the next turn', () => {
    // The turn loop freezes the enabled-name filter at turn start
    // (snapshotEnabledTools) and rebuilds the table through loopToolsFor.
    // An enable that happens mid-turn must NOT appear until the next turn.
    const { tools } = portalCtx();
    const beforeEnable = tools.snapshotEnabledTools();
    const outcome = tools.enableDeferredToolGroup('goal');
    expect(outcome.status).toBe('enabled');
    expect(tools.loopToolsFor(beforeEnable).map((tool) => tool.name)).not.toContain('CreateGoal');
    expect(tools.loopTools.map((tool) => tool.name)).toContain('CreateGoal');
  });

  it('second enable of the same group is idempotent', async () => {
    const { tools } = portalCtx();
    expect(await callPortal(tools, 'cron')).toMatchObject({ isError: false });
    const again = await callPortal(tools, 'cron');
    expect(again).toMatchObject({ isError: false, output: "Group 'cron' is already enabled." });
    // No duplicate registration.
    expect(offered(tools).filter((name) => name === 'CronCreate')).toEqual(['CronCreate']);
  });

  it('an unknown group is an error even when forced past the schema', () => {
    const { tools } = portalCtx();
    const outcome = tools.enableDeferredToolGroup('everything');
    expect(outcome.status).toBe('error');
    expect(outcome.status === 'error' && outcome.message).toBe(
      "Unknown tool group 'everything'. Available groups: cron, memory, knowledge, goal, image, make-skill, manage-plugin, inspect.",
    );
  });

  it('a group whose backing store is missing reports unavailable and stays deferred', async () => {
    // The harness agent has no memory store (no screamHomeDir), so the
    // memory group constructs nothing and must not be marked enabled.
    const { tools } = portalCtx();
    const result = await callPortal(tools, 'memory');
    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      "Group 'memory' has no tools available in this session (its backing store is not configured).",
    );
    expect(offered(tools)).not.toContain('MemoryLookup');
    const outcome = tools.enableDeferredToolGroup('memory');
    expect(outcome.status).toBe('unavailable');
  });

  it('the tool declaration fingerprint changes once a group is enabled', () => {
    // The tool table is part of the provider prefix (see
    // prefix-fingerprint.ts): enabling a group must register as a change.
    const { tools } = portalCtx();
    const before = toolDeclarationsFingerprint(tools.loopTools);
    const outcome = tools.enableDeferredToolGroup('inspect');
    expect(outcome.status).toBe('enabled');
    const after = toolDeclarationsFingerprint(tools.loopTools);
    expect(after).not.toBe(before);
  });
});

describe('toolPortal: off restores the pre-portal registry', () => {
  function offCtx(): AgentTestContext {
    return testAgent({ initialConfig: harnessConfig({ toolPortal: 'off' }) });
  }

  it('the offered list is exactly the configured set, with every deferred tool constructed', () => {
    const ctx = offCtx();
    ctx.configure({ tools: ['Bash', 'CronCreate', 'CronList', 'CronDelete'] });

    expect(ctx.agent.tools.loopTools.map((tool) => tool.name)).toEqual([
      'Bash',
      'CronCreate',
      'CronDelete',
      'CronList',
    ]);
    expect(ctx.agent.tools.getBuiltinTool('DiscoverTools')).toBeUndefined();
    // No portal interplay with the enabled set itself.
    expect(ctx.agent.tools.getActiveTools()).toEqual([
      'Bash',
      'CronCreate',
      'CronList',
      'CronDelete',
    ]);
  });

  it('the full pre-portal registry is unchanged', () => {
    const ctx = offCtx();
    ctx.configure();
    expect(ctx.agent.tools.data().map((info) => info.name)).toMatchInlineSnapshot(`
      [
        "Read",
        "ReadGroup",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "Bash",
        "python",
        "RunScript",
        "EnterPlanMode",
        "ExitPlanMode",
        "AskUserQuestion",
        "TodoList",
        "TaskList",
        "TaskOutput",
        "TaskStop",
        "Wait",
        "ReportFinding",
        "ReportArchFinding",
        "CronCreate",
        "CronList",
        "CronDelete",
        "CreateGoal",
        "UpdateGoal",
        "GetGoal",
        "SetGoalBudget",
        "WriteGoalNote",
        "InspectOwnAssets",
        "MakeSkillPlan",
        "MakeSkillApply",
        "ManagePlugin",
        "LSP",
      ]
    `);
  });

  it('the default (portal on) registry differs exactly by the portal wiring', () => {
    const off = offCtx();
    off.configure();
    const on = testAgent();
    on.configure();
    const offNames = off.agent.tools.data().map((info) => info.name);
    const onNames = on.agent.tools.data().map((info) => info.name);
    const deferredName = (name: string) =>
      DEFERRED_GROUPS.some((group) => group.toolNames.includes(name));
    const nonDeferred = (names: readonly string[]) => names.filter((name) => !deferredName(name));
    // Shared population identical, in the same construction order.
    expect(
      nonDeferred(onNames).filter((name) => name !== DEFERRED_PORTAL_TOOL_NAME),
    ).toEqual(nonDeferred(offNames));
    // Exactly the deferred names removed, exactly the portal added.
    expect(onNames.filter((name) => !offNames.includes(name))).toEqual([DEFERRED_PORTAL_TOOL_NAME]);
    expect(offNames.filter((name) => !onNames.includes(name)).every(deferredName)).toBe(true);
  });
});
