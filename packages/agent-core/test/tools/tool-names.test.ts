/**
 * Renamed built-in tools (`ast_grep` -> `AstGrep`, `ast_edit` -> `AstEdit`,
 * `python` -> `Python`). The old names keep working wherever they can still
 * arrive: a model call, a permission rule, a profile or SDK tool list, a hook
 * matcher, and a stored session (the v1.9 wire migration).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { matchPermissionRule } from '../../src/agent/permission/matches-rule';
import type { PermissionRule } from '../../src/agent/permission/types';
import { AGENT_WIRE_PROTOCOL_VERSION, FileSystemAgentRecordPersistence } from '../../src/agent/records';
import { migrateV1_8ToV1_9 } from '../../src/agent/records/migration/v1.9';
import type { LoopHooks } from '../../src/loop/index';
import { resolveAgentProfiles } from '../../src/profile/resolve';
import { HookEngine } from '../../src/session/hooks/engine';
import { canonicalToolName, legacyToolName, RENAMED_TOOL_NAMES } from '../../src/tools/tool-names';
import { testAgent } from '../agent/harness/agent';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from '../loop/fixtures/fake-llm';
import { runTurn } from '../loop/fixtures/helpers';
import { EchoTool } from '../loop/fixtures/tools';

function echoNamed(name: string): EchoTool {
  return Object.assign(new EchoTool(), { name });
}

describe('renamed tool names', () => {
  it('maps each old name to its PascalCase name and back', () => {
    expect(RENAMED_TOOL_NAMES).toEqual({ ast_grep: 'AstGrep', ast_edit: 'AstEdit', python: 'Python' });
    expect(canonicalToolName('python')).toBe('Python');
    expect(canonicalToolName('Bash')).toBe('Bash');
    expect(canonicalToolName('constructor')).toBe('constructor');
    expect(legacyToolName('AstGrep')).toBe('ast_grep');
    expect(legacyToolName('Bash')).toBeUndefined();
  });
});

describe('a model call by the old name', () => {
  it('runs the renamed tool, and policies and hooks see the current name', async () => {
    const tool = echoNamed('Python');
    const seen: string[] = [];
    const hooks: LoopHooks = {
      prepareToolExecution: async (context) => {
        seen.push(context.toolCall.name);
        return undefined;
      },
    };
    await runTurn({
      hooks,
      tools: [tool],
      responses: [
        makeToolUseResponse([makeToolCall('python', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    expect(tool.calls).toHaveLength(1);
    // A deny rule written for `Python` must not be dodged by calling `python`.
    expect(seen).toEqual(['Python']);
  });

  it('prefers a tool that really has the old name (a user or MCP tool)', async () => {
    const own = echoNamed('python');
    const builtin = echoNamed('Python');
    await runTurn({
      tools: [builtin, own],
      responses: [
        makeToolUseResponse([makeToolCall('python', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    expect(own.calls).toHaveLength(1);
    expect(builtin.calls).toHaveLength(0);
  });
});

function ruleMatches(pattern: string, toolName: string): boolean {
  const rule = { decision: 'deny', scope: 'session-runtime', pattern } as PermissionRule;
  return matchPermissionRule({ rule, toolName, execution: {} }) !== undefined;
}

const userTool = (name: string) => ({
  name,
  description: 'a user tool',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ output: 'ok' }),
});

describe('old names in configuration', () => {
  it('a permission rule on the old name matches the renamed tool, and still matches a tool that has the old name', () => {
    expect(ruleMatches('python', 'Python')).toBe(true);
    expect(ruleMatches('ast_edit(src/**)', 'AstEdit')).toBe(false); // the arg part still has to match
    expect(ruleMatches('ast_edit', 'AstEdit')).toBe(true);
    expect(ruleMatches('python', 'python')).toBe(true);
    // A rule on the current name targets the built-in only.
    expect(ruleMatches('Python', 'python')).toBe(false);
    expect(ruleMatches('Bash', 'Python')).toBe(false);
  });

  it('a profile tools list keeps the old name and gains the current one', () => {
    const profiles = resolveAgentProfiles([
      { name: 'agent', tools: ['Bash'] },
      { name: 'custom', extends: 'agent', tools: ['Read', 'ast_grep', 'python', 'Python'] },
    ]);
    expect(profiles['custom']!.tools).toEqual(['Read', 'ast_grep', 'AstGrep', 'python', 'Python']);
  });

  it('an active-tool list enables the renamed built-in for an old name', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.tools.setActiveTools(['Bash', 'ast_grep']);
    expect([...ctx.agent.tools.getActiveTools()]).toEqual(['Bash', 'ast_grep', 'AstGrep']);
    expect(ctx.agent.tools.loopTools.map((tool) => tool.name)).toContain('AstGrep');
  });

  it('an old name that a user or plugin tool really has keeps meaning that tool', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.tools.registerUserTool(userTool('python'));
    ctx.agent.tools.setActiveTools(['Bash', 'python']);
    expect([...ctx.agent.tools.getActiveTools()]).toEqual(['Bash', 'python']);
    const offered = ctx.agent.tools.loopTools.map((tool) => tool.name);
    expect(offered).toContain('python');
    expect(offered).not.toContain('Python');
  });

  it('/rlm off removes the built-in even when the list came from before the rename', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.tools.setActiveTools(['Bash', 'python']);
    await ctx.rpc.setRlmEnabled({ enabled: true });
    await ctx.rpc.setRlmEnabled({ enabled: false });
    expect([...ctx.agent.tools.getActiveTools()]).toEqual(['Bash']);

    // ...but leaves a user tool that really is called `python`.
    const withUserTool = testAgent();
    withUserTool.configure();
    withUserTool.agent.tools.registerUserTool(userTool('python'));
    withUserTool.agent.tools.setActiveTools(['Bash', 'python']);
    await withUserTool.rpc.setRlmEnabled({ enabled: true });
    await withUserTool.rpc.setRlmEnabled({ enabled: false });
    expect([...withUserTool.agent.tools.getActiveTools()]).toEqual(['Bash', 'python']);
  });

  it('a tool hook whose matcher names the old tool still fires', async () => {
    const fired: string[] = [];
    const engine = new HookEngine(
      [
        { event: 'PreToolUse', matcher: '^python$', command: 'exit 0' },
        { event: 'UserPromptSubmit', matcher: '^python$', command: 'exit 0' },
      ],
      { onTriggered: (event, target) => fired.push(`${event}:${target}`) },
    );
    await engine.trigger('PreToolUse', { matcherValue: 'Python' });
    // Only tool events translate: a prompt that says "Python" is not a tool name.
    await engine.trigger('UserPromptSubmit', { matcherValue: 'Python' });
    expect(fired).toEqual(['PreToolUse:Python']);
  });
});

describe('wire v1.8 -> v1.9', () => {
  const migrate = migrateV1_8ToV1_9.migrateRecord;

  it('renames the tool in every stored tool call', () => {
    expect(
      migrate({
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            { type: 'function', id: 'a', name: 'ast_grep', arguments: '{}' },
            { type: 'function', id: 'b', name: 'Bash', arguments: '{}' },
          ],
        },
      }),
    ).toMatchObject({ message: { toolCalls: [{ name: 'AstGrep' }, { name: 'Bash' }] } });

    expect(
      migrate({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 'a', name: 'python' } }),
    ).toMatchObject({ event: { name: 'Python' } });

    expect(
      migrate({
        type: 'context.snapshot',
        snapshot: {
          history: [{ role: 'assistant', content: [], toolCalls: [{ id: 'a', name: 'ast_edit' }] }],
          deferredMessages: [{ role: 'assistant', content: [], toolCalls: [{ id: 'b', name: 'python' }] }],
          tokenCount: 1,
        },
        compactedHistory: [],
      }),
    ).toMatchObject({
      snapshot: {
        history: [{ toolCalls: [{ name: 'AstEdit' }] }],
        deferredMessages: [{ toolCalls: [{ name: 'Python' }] }],
        tokenCount: 1,
      },
    });

  });

  it('leaves other records, other names and unexpected shapes alone', () => {
    const untouched = [
      { type: 'metadata', protocol_version: '1.8', created_at: 1 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'run python please' }] },
      { type: 'context.append_message', message: { role: 'user', content: [] } },
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'a' } },
      // Tool lists and rules stay as written; replay and matching handle them.
      { type: 'tools.set_active_tools', names: ['Bash', 'python'] },
      { type: 'request.header', activeTools: ['ast_grep'] },
      { type: 'permission.record_approval_result', toolName: 'python', sessionApprovalRule: 'python', result: {} },
      { type: 'permission.record_grant_revocation', pattern: 'ast_edit' },
    ];
    for (const record of untouched) {
      expect(migrate(record), record.type).toEqual(record);
    }
  });
});

describe('resuming a session written before the rename', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('resumes with the renamed tools enabled and the stored calls renamed', async () => {
    const dir = join(tmpdir(), `tool-rename-resume-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    dirs.push(dir);
    const wirePath = join(dir, 'wire.jsonl');
    const lines = [
      { type: 'metadata', protocol_version: '1.8', created_at: 1 },
      { type: 'tools.set_active_tools', names: ['Bash', 'python', 'ast_grep'] },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] } },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'c1', name: 'python', arguments: '{"code":"1"}' }],
        },
      },
    ];
    await writeFile(wirePath, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');

    const { agent } = testAgent({ persistence: new FileSystemAgentRecordPersistence(wirePath) });
    await agent.records.replay();

    expect([...agent.tools.getActiveTools()]).toEqual(['Bash', 'python', 'Python', 'ast_grep', 'AstGrep']);
    const toolCalls = agent.context.history.flatMap((message) => message.toolCalls.map((call) => call.name));
    expect(toolCalls).toEqual(['Python']);
    const rewritten = await readFile(wirePath, 'utf8');
    expect(rewritten).toContain(`"protocol_version":"${AGENT_WIRE_PROTOCOL_VERSION}"`);
    expect(rewritten).toContain('"name":"Python"');
    expect(rewritten).not.toContain('"name":"python"');
  });
});
