import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../src/agent';
import { PermissionManager } from '../../src/agent/permission';
import { BotModePermissionPolicy } from '../../src/agent/permission/policies/bot-mode-permission';
import type { PermissionPolicyContext } from '../../src/agent/permission/types';
import { actionKey, decideInboxItem, listInbox, readApprovedActions } from '../../src/session/inbox';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'inbox-'));
  homes.push(home);
  const oneShot = new Set<string>();
  const permission = {
    mode: 'bot',
    taintedPrivateReads: [],
    hasPendingPrivateReads: () => false,
    sessionApprovalRulePatterns: [],
    consumeOneShotApproval: (key: string) => oneShot.delete(key),
  };
  const agent = {
    type: 'main',
    sessionId: 'ses-1',
    screamHomeDir: home,
    config: { cwd: '/w' },
    permission,
  } as unknown as Agent;
  return { home, policy: new BotModePermissionPolicy(agent), oneShot };
}

function call(tool: string, args: unknown): PermissionPolicyContext {
  return { toolCall: { id: 'c1', name: tool, args: JSON.stringify(args) }, args } as unknown as PermissionPolicyContext;
}

describe('bot mode and the inbox', () => {
  it('puts a refused action in the inbox once, and tells the model to carry on', () => {
    const { home, policy } = setup();
    const push = call('Bash', { command: 'git push origin main' });
    const first = policy.evaluate(push);
    expect(first).toMatchObject({ kind: 'deny' });
    expect(first?.kind === 'deny' && first.message).toContain('waiting for the person');
    policy.evaluate(push);
    const items = listInbox(home);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'approval',
      sessionId: 'ses-1',
      status: 'pending',
      approval: { tool: 'Bash', action: 'git push origin main' },
    });
  });

  it('lets an action approved once through exactly once', () => {
    const { policy, oneShot } = setup();
    const push = call('Bash', { command: 'git push origin main' });
    oneShot.add(actionKey('Bash', { command: 'git push origin main' }));
    expect(policy.evaluate(push)).toMatchObject({ kind: 'approve' });
    expect(policy.evaluate(push)).toMatchObject({ kind: 'deny' });
  });

  it('lets an always-allowed action through from then on, and only that action', () => {
    const { home, policy } = setup();
    policy.evaluate(call('Bash', { command: 'git push origin main' }));
    const [item] = listInbox(home);
    expect(decideInboxItem(home, item!.id, 'always')).toMatchObject({ status: 'decided', decision: 'always' });
    expect(readApprovedActions(home).size).toBe(1);
    expect(policy.evaluate(call('Bash', { command: 'git push origin main' }))).toMatchObject({ kind: 'approve' });
    expect(policy.evaluate(call('Bash', { command: 'git push --force origin main' }))).toMatchObject({ kind: 'deny' });
  });

  it('sends a question to the person instead of making the model guess', () => {
    const { home, policy } = setup();
    const result = policy.evaluate(
      call('AskUserQuestion', { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }),
    );
    expect(result?.kind === 'deny' && result.message).toContain('sent to the person');
    expect(listInbox(home)[0]).toMatchObject({
      kind: 'question',
      question: { items: [{ question: 'Which branch?', options: ['main', 'dev'] }] },
    });
  });
});

describe('inbox decisions', () => {
  it('refuses a decision on an expired item, or the wrong kind of decision', () => {
    const { home, policy } = setup();
    policy.evaluate(call('Bash', { command: 'rm -rf build' }));
    const [item] = listInbox(home);
    expect(decideInboxItem(home, item!.id, 'answer', 'x')).toBeUndefined();
    expect(decideInboxItem(home, item!.id, 'approve', undefined, item!.expiresAt + 1)).toBeUndefined();
    expect(listInbox(home)[0]?.status).toBe('expired');
  });

  it('ignores the order of keys when telling two actions apart', () => {
    expect(actionKey('Edit', { path: 'a', old: 'x' })).toBe(actionKey('Edit', { old: 'x', path: 'a' }));
    expect(actionKey('Edit', { path: 'a' })).not.toBe(actionKey('Edit', { path: 'b' }));
  });
});

describe('PermissionManager one-shot approvals', () => {
  it('is used up by the first use', () => {
    const manager = Object.create(PermissionManager.prototype) as PermissionManager;
    (manager as unknown as { oneShotApprovals: Set<string> }).oneShotApprovals = new Set();
    manager.grantOneShotApproval('k');
    expect(manager.consumeOneShotApproval('k')).toBe(true);
    expect(manager.consumeOneShotApproval('k')).toBe(false);
  });
});

describe('always allow for background branches', () => {
  it('remembers a push of a scream/ branch for every later scream/ branch, and nothing else', () => {
    const { home, policy } = setup();
    policy.evaluate(call('Bash', { command: 'git push origin scream/job-1a2b/20261118-0200' }));
    const [item] = listInbox(home);
    decideInboxItem(home, item!.id, 'always');
    expect(policy.evaluate(call('Bash', { command: 'git push origin scream/job-1a2b/20261119-0200' }))).toMatchObject({ kind: 'approve' });
    expect(policy.evaluate(call('Bash', { command: 'git push origin scream/job-9z/20261201-0300' }))).toMatchObject({ kind: 'approve' });
    expect(policy.evaluate(call('Bash', { command: 'git push origin main' }))).toMatchObject({ kind: 'deny' });
    expect(policy.evaluate(call('Bash', { command: 'git push --force origin scream/job-1a2b/20261120-0200' }))).toMatchObject({ kind: 'deny' });
  });
});

describe('deleting background tasks in bot mode', () => {
  it('deletes a task the agent made, and asks the person before deleting one they set up', async () => {
    const { JobStore } = await import('../../src/jobs/store');
    const { home, policy } = setup();
    const store = new JobStore(home);
    const base = { prompt: 'p', starts: { kind: 'cron', cron: '0 9 * * *' } as const, workDir: home };
    const mine = await store.add({ ...base, title: 'agent task', createdBy: 'agent' });
    const theirs = await store.add({ ...base, title: 'person task', createdBy: 'person' });
    expect(policy.evaluate(call('JobDelete', { id: mine.id }))).toMatchObject({ kind: 'approve' });
    const denied = policy.evaluate(call('JobDelete', { id: theirs.id }));
    expect(denied).toMatchObject({ kind: 'deny' });
    expect(listInbox(home).find((item) => item.approval?.tool === 'JobDelete')).toMatchObject({
      kind: 'approval',
      status: 'pending',
    });
    expect(policy.evaluate(call('JobDelete', { id: 'job-00000000' }))).toMatchObject({ kind: 'approve' });
  });
});
