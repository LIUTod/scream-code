/**
 * The main agent of a real session can look memories up and save one from
 * the first turn — "how did we fix this last time" and "remember this" do
 * not wait for DiscoverTools. Correcting and consolidating stay behind it.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRPC, ScreamCore, type ApprovalResponse, type CoreAPI, type SDKAPI } from '../../src';

describe('memory tools in a real session', () => {
  let tmp: string;
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('offers MemoryLookup and MemoryWrite directly, MemoryEdit through the portal', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'memory-tools-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new ScreamCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    const created = await rpc.createSession({ id: 'ses_memory_tools', workDir });
    const main = core.sessions.get(created.id)!.agents.get('main')!;
    const enabled = [...main.tools.snapshotEnabledTools().names];
    expect(enabled).toEqual(expect.arrayContaining(['MemoryLookup', 'MemoryWrite', 'DiscoverTools']));
    expect(enabled).not.toContain('MemoryEdit');
    expect(enabled).not.toContain('MemoryConsolidatePlan');
    await rpc.closeSession({ sessionId: created.id });
  });
});
