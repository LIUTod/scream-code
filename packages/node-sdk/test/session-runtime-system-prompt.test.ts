import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ScreamHarness } from '#/index';
import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setRuntimeSystemPrompt', () => {
  it('updates the in-memory session overlay without persisting it to the agent wire', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-runtime-prompt-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-runtime-prompt-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_runtime_prompt', workDir });

      await session.setRuntimeSystemPrompt({
        replace: 'runtime replacement',
        append: 'runtime append',
      });
      await session.close({ extractMemories: false });

      const wirePath = join(session.summary!.sessionDir, 'agents', 'main', 'wire.jsonl');
      const wire = await readFile(wirePath, 'utf-8');
      expect(wire).not.toContain('runtime replacement');
      expect(wire).not.toContain('runtime append');
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-runtime-prompt-closed-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-runtime-prompt-closed-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_runtime_prompt_closed', workDir });
      await session.close({ extractMemories: false });

      await expect(session.setRuntimeSystemPrompt({ append: 'late' })).rejects.toMatchObject({
        code: 'session.closed',
      });
    } finally {
      await harness.close();
    }
  });
});
