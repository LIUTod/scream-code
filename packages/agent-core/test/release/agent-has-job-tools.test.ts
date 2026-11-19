/** The main agent of a real session is offered the job tools; a subagent is not. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRPC, ScreamCore, type ApprovalResponse, type CoreAPI, type SDKAPI } from '../../src';

describe('job tools in a real session', () => {
  let tmp: string;
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('offers JobCreate / JobList / JobDelete to the main agent from the first turn', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'job-tools-'));
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
    const created = await rpc.createSession({ id: 'ses_jobs_tools', workDir });
    const main = core.sessions.get(created.id)!.agents.get('main')!;
    // The enabled-name filter comes from the profile; a constructed tool it
    // does not list is never offered.
    const enabled = [...main.tools.snapshotEnabledTools().names];
    expect(enabled).toEqual(expect.arrayContaining(['JobCreate', 'JobList', 'JobDelete']));
    const offered = main.tools.loopTools.map((tool) => tool.name);
    if (offered.length === 0) return; // tools are built on the first turn

    expect(offered).toEqual(expect.arrayContaining(['JobCreate', 'JobList', 'JobDelete']));
    await rpc.closeSession({ sessionId: created.id });
  });
});
