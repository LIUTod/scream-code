import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session, findMcpInstructionsBlock } from '../../src/session';
import { testJian } from '../fixtures/test-jian';

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: 'unsupported', isError: true })),
  } as SDKSessionRPC;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

async function fixture(): Promise<{ sessionDir: string; workDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scream-mcp-resume-'));
  tempDirs.push(root);
  const workDir = join(root, 'work');
  const sessionDir = join(root, 'session');
  await mkdir(workDir, { recursive: true });
  return { sessionDir, workDir };
}

describe('MCP instructions on resume', () => {
  it('schedules instruction delivery after a resume (resume bypasses createMain)', async () => {
    const { sessionDir, workDir } = await fixture();
    const options = {
      jian: testJian.withCwd(workDir),
      id: 'resume-instructions',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    } as const;

    // Persist a session first, then close it: resume reads its metadata.
    const first = new Session(options as never);
    await first.createMain();
    await first.close();

    const resumed = new Session(options as never);
    const inject = vi.fn();
    (resumed as unknown as { injectMcpInstructions: () => void }).injectMcpInstructions = inject;

    await resumed.resume();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Without the resume hook this never fires: createMain is the only other
    // delivery point, and resume does not go through it.
    expect(inject).toHaveBeenCalled();
    await resumed.close();
  }, 20_000);

  it('seeds the dedup state from the replayed block and ignores unrelated messages', () => {
    const block = '<mcp-server-instructions>\n- **docs**: prefer /docs\n</mcp-server-instructions>';
    const message = (text: string, origin: unknown) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      toolCalls: [],
      origin,
    });

    expect(
      findMcpInstructionsBlock([
        message('hello', { kind: 'user' }),
        message(block, { kind: 'injection', variant: 'mcp-instructions' }),
        message('later user text', { kind: 'user' }),
      ] as never),
    ).toBe(block);

    // Latest wins: a re-injected block after a server changed is the current one.
    expect(
      findMcpInstructionsBlock([
        message(block, { kind: 'injection', variant: 'mcp-instructions' }),
        message('<mcp-server-instructions>\nnew\n</mcp-server-instructions>', {
          kind: 'injection',
          variant: 'mcp-instructions',
        }),
      ] as never),
    ).toBe('<mcp-server-instructions>\nnew\n</mcp-server-instructions>');

    // Nothing to seed on a fresh session or when only other injections exist.
    expect(findMcpInstructionsBlock([])).toBe('');
    expect(
      findMcpInstructionsBlock([message('plan mode', { kind: 'injection', variant: 'plan-mode' })] as never),
    ).toBe('');
  });
});
