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

import { parsePattern } from '../../src/agent/permission/matches-rule';
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

describe('old names in configuration', () => {
  it('a permission rule on the old name targets the renamed tool', () => {
    expect(parsePattern('python')).toEqual({ toolName: 'Python' });
    expect(parsePattern('ast_edit(src/**)')).toEqual({ toolName: 'AstEdit', argPattern: 'src/**' });
    expect(parsePattern('Bash(git *)')).toEqual({ toolName: 'Bash', argPattern: 'git *' });
  });

  it('a profile tools list and an SDK active-tool list are stored with current names', () => {
    const profiles = resolveAgentProfiles([
      { name: 'agent', tools: ['Bash'] },
      { name: 'custom', extends: 'agent', tools: ['Read', 'ast_grep', 'python'] },
    ]);
    expect(profiles['custom']!.tools).toEqual(['Read', 'AstGrep', 'Python']);

    const ctx = testAgent();
    ctx.configure();
    ctx.agent.tools.setActiveTools(['Bash', 'ast_grep']);
    expect([...ctx.agent.tools.getActiveTools()]).toEqual(['Bash', 'AstGrep']);
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

  it('renames tool names in every record that carries one', () => {
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

    expect(migrate({ type: 'tools.set_active_tools', names: ['Bash', 'python', 'mcp__x__*'] })).toEqual({
      type: 'tools.set_active_tools',
      names: ['Bash', 'Python', 'mcp__x__*'],
    });
    expect(migrate({ type: 'request.header', activeTools: ['ast_grep'] })).toMatchObject({ activeTools: ['AstGrep'] });
    expect(migrate({ type: 'permission.record_decision', toolName: 'python' })).toMatchObject({ toolName: 'Python' });
    expect(
      migrate({ type: 'permission.record_approval_result', toolName: 'ast_edit', sessionApprovalRule: 'ast_edit(/w/a.ts)' }),
    ).toMatchObject({ toolName: 'AstEdit', sessionApprovalRule: 'AstEdit(/w/a.ts)' });
    expect(migrate({ type: 'permission.record_grant_revocation', pattern: 'python' })).toEqual({
      type: 'permission.record_grant_revocation',
      pattern: 'Python',
    });
  });

  it('leaves other records, other names and unexpected shapes alone', () => {
    const untouched = [
      { type: 'metadata', protocol_version: '1.8', created_at: 1 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'run python please' }] },
      { type: 'context.append_message', message: { role: 'user', content: [] } },
      { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'a' } },
      { type: 'permission.record_approval_result', toolName: 'Bash', result: {} },
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

  it('restores the old names as the current ones and rewrites the wire', async () => {
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

    expect([...agent.tools.getActiveTools()]).toEqual(['Bash', 'Python', 'AstGrep']);
    const toolCalls = agent.context.history.flatMap((message) => message.toolCalls.map((call) => call.name));
    expect(toolCalls).toEqual(['Python']);
    const rewritten = await readFile(wirePath, 'utf8');
    expect(rewritten).toContain(`"protocol_version":"${AGENT_WIRE_PROTOCOL_VERSION}"`);
    expect(rewritten).not.toMatch(/"(python|ast_grep)"/);
  });
});
