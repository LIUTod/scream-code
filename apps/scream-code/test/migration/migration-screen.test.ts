import { describe, expect, it, vi } from 'vitest';
import {
  MigrationScreenComponent,
  type MigrationScreenResult,
} from '#/migration/migration-screen';
import { darkColors } from '#/tui/theme/colors';
import type {
  MigrationPlan,
  MigrationReport,
  RunMigrationInput,
} from '@scream-cli/migration-legacy';

function makePlan(over: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    sourceHome: '/x/.scream',
    hasConfig: true,
    hasMcp: true,
    hasUserHistory: true,
    oauthCredentials: ['scream-code.json'],
    workdirs: [],
    detectedPlugins: [],
    detectedMcpOauthServers: [],
    totalSessions: 1365,
    ...over,
  };
}

function render(c: MigrationScreenComponent): string {
  return c.render(80).join('\n');
}

describe('MigrationScreenComponent — ask phase', () => {
  it('ask1 renders the intro block and three options', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    const out = render(c);
    expect(out).toContain('从 scream-cli 迁移');
    expect(out).toContain('1365 个会话');
    expect(out).toContain('立即迁移');
    expect(out).toContain('稍后询问');
    expect(out).toContain('不再询问');
  });

  it('ask1 summary does not mention scream-cli login (oauth is not a migrated kind)', async () => {
    // OAuth credentials are deliberately never migrated, so the pre-migration
    // summary must not list "scream-cli login" alongside the real migratable
    // data classes — that framing makes users believe their session will
    // carry over, which it does not.
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    const out = render(c);
    expect(out).not.toContain('scream-cli login');
    expect(out).not.toContain('/login');
  });

  it('picking "稍后询问" at ask1 completes with decision=later', () => {
    let result: { decision: string } | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: (r) => {
        result = r;
      },
    });
    c.handleInput('\u001B[B'); // Down -> "稍后询问"
    c.handleInput('\r'); // Enter
    expect(result?.decision).toBe('later');
  });

  it('"立即迁移" -> "仅配置" advances ask1 -> ask2 and resolves scope.sessions=false', async () => {
    let captured: RunMigrationInput | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      runMigration: async (input) => {
        captured = input;
        return makeReport();
      },
      onComplete: () => {},
    });
    c.handleInput('\r'); // ask1: "立即迁移"
    c.handleInput('\r'); // ask2: "仅配置" (first option)
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.scope.sessions).toBe(false);
  });

  it('"立即迁移" -> "Config + sessions" begins migration immediately with sessions=true', async () => {
    let captured: RunMigrationInput | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      runMigration: async (input) => {
        captured = input;
        return makeReport();
      },
      onComplete: () => {},
    });
    c.handleInput('\r'); // ask1: 立即迁移
    c.handleInput('\u001B[B'); // ask2: down -> 配置 + 1365 个会话
    c.handleInput('\r'); // ask2 select -> "Config + N sessions" begins migration immediately
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.scope.sessions).toBe(true);
  });

  it('ask2 shows the detected session count alongside the "config only" option', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan({ totalSessions: 1365 }),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c.handleInput('\r'); // ask1: 立即迁移 -> ask2
    const out = render(c);
    expect(out).toContain('仅配置');
    // Concrete count so the user sees the cost of "+ sessions" up front.
    expect(out).toContain('配置 + 1365 个会话');
    expect(out).not.toContain('Most recent');
    expect(out).not.toContain('立即迁移');
  });

  it('ask2 falls back to "配置 + 所有会话" when no sessions were detected', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan({ totalSessions: 0 }),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c.handleInput('\r'); // ask1 -> ask2
    const out = render(c);
    expect(out).toContain('配置 + 所有会话');
    // "Config + 0 sessions" would read as an obvious dead-end.
    expect(out).not.toContain('Config + 0 sessions');
  });

  it('skipDecisionStep starts at the scope question with the now/later/never gate hidden', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      skipDecisionStep: true,
      onComplete: () => {},
    });
    const out = render(c);
    expect(out).toContain('是否同时迁移聊天会话?（数据量较大且速度较慢）');
    expect(out).not.toContain('立即迁移');
    expect(out).not.toContain('不再询问');
  });

  it('skipDecisionStep -> "仅配置" resolves scope without the decision step', async () => {
    let captured: RunMigrationInput | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      skipDecisionStep: true,
      runMigration: async (input) => {
        captured = input;
        return makeReport();
      },
      onComplete: () => {},
    });
    c.handleInput('\r'); // ask2: "仅配置" (first option) — no ask1 gate
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.scope.sessions).toBe(false);
  });
});

describe('MigrationScreenComponent — progress phase', () => {
  it('renders a step checklist and the session counter when in progress', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    // expose progress rendering via the test hook (see Step 5.2)
    c._testEnterProgress();
    c._testUpdateStep('config done');
    c._testUpdateSessionProgress(32, 50);
    const out = c.render(80).join('\n');
    expect(out).toContain('正在从 scream-cli 迁移');
    expect(out).toContain('32 / 50');
    expect(out).toContain('配置');
  });

  it('animates the progress spinner while a migration step runs', async () => {
    vi.useFakeTimers();
    try {
      const c = new MigrationScreenComponent({
        plan: makePlan(),
        sourceHome: '/x/.scream',
        targetHome: '/y/.scream-code',
        colors: darkColors,
        skipDecisionStep: true,
        // A migration that never settles keeps the screen in the progress
        // phase so the spinner animation can be observed.
        runMigration: () => new Promise<MigrationReport>(() => {}),
        onComplete: () => {},
      });
      c.handleInput('\r'); // ask2: "仅配置" -> migration begins
      c._testUpdateSessionProgress(1, 3); // surface the spinner line
      const before = c.render(80).join('\n');
      vi.advanceTimersByTime(400); // several spinner frames
      const after = c.render(80).join('\n');
      // Before the fix nothing advanced the spinner — the frame, and the whole
      // progress render, stayed frozen on the first braille glyph.
      expect(after).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks Config and MCP as independent steps', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testEnterProgress();
    c._testUpdateStep('config done'); // config finished; MCP has not started
    const out = c.render(80).join('\n');
    // Four checklist rows (config, mcp, user-history, sessions). With only
    // config done, exactly one shows ✓ and the other three show ◐ — MCP is
    // its own step and stays pending.
    expect((out.match(/✓/g) ?? []).length).toBe(1);
    expect((out.match(/◐/g) ?? []).length).toBe(3);
  });
});

function makeReport(
  over: Partial<MigrationReport['summary']['sessions']> = {},
  summaryOver: Partial<MigrationReport['summary']> = {},
  noticesOver: Partial<MigrationReport['notices']> = {},
): MigrationReport {
  return {
    startedAt: 's',
    completedAt: 'e',
    migratorVersion: '0.1.1',
    source: '/x/.scream',
    target: '/y/.scream-code',
    summary: {
      config: {
        migrated: true,
        tuiExtracted: false,
        droppedProviders: [],
        droppedModels: [],
        droppedKeys: [],
        configConflicts: [],
        wroteSiblingDueToConflict: false,
        wroteTuiSibling: false,
        migratedHooks: 0,
        droppedHooks: 0,
        siblingContents: { providers: [], models: [], hooks: 0 },
      },
      mcp: { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false },
      userHistory: { copied: 12, skippedExisting: 0 },
      skills: { copied: 0, skippedExisting: 0 },
      sessions: {
        scope: 'all',
        bucketsScanned: 0,
        bucketsSkippedNonlocalJian: 0,
        bucketsSkippedNoWorkdirFound: 0,
        sessionsAttempted: 50,
        sessionsMigrated: 50,
        sessionsAlreadyMigrated: 0,
        sessionsSkippedPlaceholder: 0,
        sessionsSkippedEmpty: 0,
        sessionsSkippedMalformed: 0,
        sessionsFailed: [],
        sessionsConflicts: [],
        ...over,
      },
      ...summaryOver,
    },
    notices: {
      mcpOauthServersRequiringReauth: [],
      oauthLoginsRequiringRelogin: [],
      detectedPlugins: ['p1', 'p2'],
      configConflictNotice: null,
      tuiConflictNotice: null,
      ...noticesOver,
    },
  };
}

describe('MigrationScreenComponent — result phase', () => {
  it('renders the report summary including plugin notices', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(makeReport());
    const out = c.render(80).join('\n');
    expect(out).toContain('迁移完成');
    expect(out).toContain('50 个会话已迁移');
    expect(out).toContain('2 个 scream-cli 插件');
  });

  it('renders migrated hooks in the ✓ line and dropped hooks as a warning', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 2,
            droppedHooks: 1,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('· hooks'); // appears in the ✓ migrated-kinds line
    expect(out).toContain('1 个 hook 不兼容，已丢弃');
  });

  it('Enter on the result screen completes with the prior decision', () => {
    let result: MigrationScreenResult | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: (r) => {
        result = r;
      },
    });
    c._testShowResult(makeReport());
    c.handleInput('\r');
    expect(result?.decision).toBe('now');
    expect(result?.migrated).toBe(true);
  });

  it('omits a data class from the result when it was not migrated', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    // config skipped (e.g. a malformed legacy config.toml).
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: false,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    // REPL 历史 (copied) is still shown...
    expect(out).toContain('REPL 历史');
    // ...but config must not be claimed as migrated.
    expect(out).not.toContain('config');
  });

  it('surfaces conflict and failure warnings on the result screen', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        { sessionsFailed: [{ sourcePath: '/s', reason: 'bad' }] },
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: true,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
          mcp: { mergedServers: ['m'], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: true },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('config.migrated-from-scream-cli.toml');
    expect(out).toContain('mcp.migrated-from-scream-cli.json');
    expect(out).toContain('1 个会话迁移失败');
  });

  it('lists sibling-file contents in the config-fallback warning so the user knows what to merge', () => {
    // When the target's `config.toml` could not be parsed and migration writes
    // to `config.migrated-from-scream-cli.toml` instead, the result screen must
    // (a) name the sibling, (b) say what's in it so the user knows what to
    // merge by hand, and (c) describe the trigger accurately (parse failure,
    // not "unreadable"). Otherwise users have to crack the file open to find
    // out — and they may not realize hooks landed in there at all.
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: [],
            wroteSiblingDueToConflict: true,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            siblingContents: {
              providers: ['openai', 'managed:scream-code'],
              models: ['gpt4'],
              hooks: 3,
            },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('config.migrated-from-scream-cli.toml');
    // Accurate trigger description (file parses, not "unreadable").
    expect(out).toContain('config.toml 无法解析');
    // Enumeration of what's inside the sibling.
    expect(out).toContain('2 个 provider');
    expect(out).toContain('1 个 model');
    expect(out).toContain('3 个 hook');
  });

  it('shows skipped empty sessions as a muted line, not a failure', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(makeReport({ sessionsSkippedEmpty: 3 }));
    const out = c.render(80).join('\n');
    expect(out).toContain('3 个空会话已跳过');
    // It is informational, not a failure.
    expect(out).not.toContain('3 个会话迁移失败');
  });

  it('lists kept config settings on the result screen when scream-cli differed', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(
      makeReport(
        {},
        {
          config: {
            migrated: true,
            tuiExtracted: false,
            droppedProviders: [],
            droppedModels: [],
            droppedKeys: [],
            configConflicts: ['default_model', 'providers.scream'],
            wroteSiblingDueToConflict: false,
            wroteTuiSibling: false,
            migratedHooks: 0,
            droppedHooks: 0,
            siblingContents: { providers: [], models: [], hooks: 0 },
          },
        },
      ),
    );
    const out = c.render(80).join('\n');
    expect(out).toContain('2 个配置冲突，保留了你本地的版本');
    expect(out).toContain('default_model · providers.scream');
  });

  it('surfaces MCP servers that need re-authentication', () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
    });
    c._testShowResult(makeReport({}, {}, { mcpOauthServersRequiringReauth: ['srv-a', 'srv-b'] }));
    const out = c.render(80).join('\n');
    expect(out).toContain('2 个 MCP 服务器需要重新认证');
  });
});

describe('MigrationScreenComponent — execution wiring', () => {
  it('runs migration after the ask phase and lands on the result phase', async () => {
    const fakeReport = makeReport();
    let onCompleteResult: MigrationScreenResult | undefined;
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: (r) => {
        onCompleteResult = r;
      },
      // injected runner for testability — no filesystem access
      runMigration: async (_input) => fakeReport,
    });
    c.handleInput('\r'); // ask1: 立即迁移
    c.handleInput('\r'); // ask2: 仅配置 -> begins migration
    // migration is async; wait a tick
    await new Promise((res) => setTimeout(res, 0));
    expect(c.render(80).join('\n')).toContain('迁移完成');
    c.handleInput('\r'); // dismiss result
    expect(onCompleteResult?.decision).toBe('now');
    expect(onCompleteResult?.migrated).toBe(true);
  });

  it('lands on the failure screen when the runner rejects', async () => {
    const c = new MigrationScreenComponent({
      plan: makePlan(),
      sourceHome: '/x/.scream',
      targetHome: '/y/.scream-code',
      colors: darkColors,
      onComplete: () => {},
      runMigration: async () => {
        throw new Error('boom');
      },
    });
    c.handleInput('\r'); // ask1: 立即迁移
    c.handleInput('\r'); // ask2: 仅配置 -> begins migration
    await new Promise((res) => setTimeout(res, 0));
    expect(c.render(80).join('\n')).toContain('迁移失败');
  });
});
