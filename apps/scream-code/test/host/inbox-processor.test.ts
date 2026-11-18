import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideInboxItem, listInbox, type Event, type InboxItem, type ScreamHarness, type Session } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decisionPrompt, InboxProcessor } from '#/host/inbox-processor';
import { inboxDecisionCommand, inboxNotice } from '#/line/background-commands';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-proc-'));
  homes.push(dir);
  mkdirSync(join(dir, 'host', 'inbox'), { recursive: true });
  return dir;
}

function writeItem(dir: string, item: Partial<InboxItem> & { id: string; sessionId: string }): void {
  const full: InboxItem = {
    kind: 'approval',
    workDir: '/w',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    status: 'pending',
    approval: { tool: 'Bash', action: 'git push origin main', key: 'k1', reason: 'bot: irreversible' },
    ...item,
  } as InboxItem;
  writeFileSync(join(dir, 'host', 'inbox', `${item.id}.json`), JSON.stringify(full));
}

function fakeHarness() {
  const prompts: string[] = [];
  const grants: string[] = [];
  const harness = {
    resumeSession: vi.fn(async ({ id }: { id: string }) => {
      const listeners = new Set<(event: Event) => void>();
      return {
        id,
        onEvent(listener: (event: Event) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async grantOneShotApproval(key: string) {
          grants.push(key);
          return true;
        },
        async prompt(text: string) {
          prompts.push(text);
          setTimeout(() => {
            for (const l of listeners) l({ type: 'turn.started', agentId: 'main' } as unknown as Event);
            for (const l of listeners) l({ type: 'turn.ended', agentId: 'main', reason: 'completed' } as unknown as Event);
          }, 1);
        },
        async close() {},
      } as unknown as Session;
    }),
  };
  return { harness: harness as unknown as ScreamHarness & typeof harness, prompts, grants };
}

describe('InboxProcessor', () => {
  it('pushes a new item to the chat it came from once', async () => {
    const dir = home();
    writeItem(dir, { id: 'inbox-aaa', sessionId: 'line-feishu-x' });
    const notify = vi.fn(async (_sessionKey: string, _text: string) => {});
    const processor = new InboxProcessor({ harness: fakeHarness().harness, screamHomeDir: dir, notify, formatNotice: inboxNotice });
    await processor.sweep();
    await processor.sweep();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('line-feishu-x');
    expect(notify.mock.calls[0]![1]).toContain('/approve inbox-aaa');
  });

  it('sends items from other sessions to the chat the person last wrote from', async () => {
    const dir = home();
    writeItem(dir, { id: 'inbox-bbb', sessionId: 'session_1' });
    const notify = vi.fn(async (_sessionKey: string, _text: string) => {});
    const processor = new InboxProcessor({
      harness: fakeHarness().harness,
      screamHomeDir: dir,
      notify,
      ownerChat: () => 'line-weixin-me',
      formatNotice: inboxNotice,
    });
    await processor.sweep();
    expect(notify).toHaveBeenCalledWith('line-weixin-me', expect.any(String));
  });

  it('expires an item nobody answered', async () => {
    const dir = home();
    writeItem(dir, { id: 'inbox-ccc', sessionId: 'session_1', expiresAt: Date.now() - 1 });
    const processor = new InboxProcessor({ harness: fakeHarness().harness, screamHomeDir: dir, formatNotice: inboxNotice });
    await processor.sweep();
    expect(listInbox(dir)[0]?.status).toBe('expired');
  });

  it('delivers an approval: opens the session, lets the action through once, and says so', async () => {
    const dir = home();
    writeItem(dir, { id: 'inbox-ddd', sessionId: 'session_1', notified: true });
    decideInboxItem(dir, 'inbox-ddd', 'approve');
    const { harness, prompts, grants } = fakeHarness();
    const processor = new InboxProcessor({ harness, screamHomeDir: dir, formatNotice: inboxNotice });
    await processor.sweep();
    for (let i = 0; i < 300 && listInbox(dir)[0]?.status !== 'delivered'; i++) await new Promise((r) => setTimeout(r, 10));
    await vi.waitFor(
      () => {
        expect(prompts).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
    expect(grants).toEqual(['k1']);
    expect(prompts[0]).toContain('The person approved this action');
    expect(listInbox(dir)[0]?.status).toBe('delivered');
  });
});

describe('decisionPrompt', () => {
  it('tells the run what the person decided', () => {
    const base = { id: 'inbox-x', approval: { tool: 'Bash', action: 'rm -rf build', key: 'k', reason: '' } } as InboxItem;
    expect(decisionPrompt({ ...base, decision: 'reject' })).toContain('rejected');
    expect(decisionPrompt({ ...base, decision: 'did-it' })).toContain('did this themselves');
    expect(decisionPrompt({ ...base, kind: 'question', decision: 'answer', answer: 'dev' })).toContain('dev');
  });
});

describe('chat inbox commands', () => {
  it('approves, always-approves, rejects and answers by id', () => {
    const dir = home();
    writeItem(dir, { id: 'inbox-e1', sessionId: 's' });
    writeItem(dir, { id: 'inbox-e2', sessionId: 's' });
    writeItem(dir, {
      id: 'inbox-e3',
      sessionId: 's',
      kind: 'question',
      approval: undefined,
      question: { items: [{ question: 'Which?', options: [] }] },
    });
    expect(inboxDecisionCommand(dir, '/approve', ' inbox-e1 always')).toContain('以后无人值守时');
    expect(inboxDecisionCommand(dir, '/reject', ' inbox-e2')).toContain('不做这件事');
    expect(inboxDecisionCommand(dir, '/answer', ' inbox-e3')).toContain('请写上回答');
    expect(inboxDecisionCommand(dir, '/answer', ' inbox-e3 use dev')).toContain('已把你的回答');
    expect(inboxDecisionCommand(dir, '/approve', ' inbox-e1')).toContain('没有待处理的');
    const byId = new Map(listInbox(dir).map((item) => [item.id, item]));
    expect(byId.get('inbox-e1')?.decision).toBe('always');
    expect(byId.get('inbox-e3')?.answer).toBe('use dev');
  });
});

describe('memory items', () => {
  it('saves approved memories without opening a session, and answers in the chat', async () => {
    const dir = home();
    const memo = {
      id: 'memo-x',
      sourceSessionId: 'job-run-1',
      userNeed: 'run tests twice',
      approach: 'a',
      outcome: 'done',
      whatFailed: 'none',
      whatWorked: 'retry flaky suite',
      extractionSource: 'exit',
      recordedAt: Date.now(),
      projectDir: dir,
    };
    writeItem(dir, { id: 'inbox-m1', sessionId: 'job-run-1', kind: 'memory', approval: undefined, memories: [memo] } as never);
    expect(inboxNotice(listInbox(dir)[0]!)).toContain('/approve inbox-m1');
    expect(inboxDecisionCommand(dir, '/approve', ' inbox-m1')).toContain('保存');
    const { harness } = fakeHarness();
    const processor = new InboxProcessor({ harness, screamHomeDir: dir, formatNotice: inboxNotice });
    await processor.sweep();
    await vi.waitFor(
      () => {
        expect(listInbox(dir)[0]?.status).toBe('delivered');
      },
      { timeout: 3_000 },
    );
    expect(harness.resumeSession).not.toHaveBeenCalled();
    const { sharedMemoStore, closeSharedMemoStore } = await import('@scream-code/memory');
    const store = sharedMemoStore(dir);
    await store.init();
    await vi.waitFor(async () => {
      expect((await store.list()).memos.map((m) => m.id)).toEqual(['memo-x']);
    });
    closeSharedMemoStore(dir);
  });
});

describe('stale copies never overwrite a decision', () => {
  it('does not write an item back as pending after it was decided during a push', async () => {
    const dir = home();
    writeItem(dir, { id: 'inbox-r1', sessionId: 'line-feishu-x' });
    writeItem(dir, { id: 'inbox-r2', sessionId: 'line-feishu-x' });
    const notify = vi.fn(async (_key: string, text: string) => {
      // While the first push is in flight, the person approves the second item.
      if (text.includes('inbox-r1')) decideInboxItem(dir, 'inbox-r2', 'reject');
    });
    const processor = new InboxProcessor({ harness: fakeHarness().harness, screamHomeDir: dir, notify, formatNotice: inboxNotice });
    await processor.sweep();
    const byId = new Map(listInbox(dir).map((item) => [item.id, item]));
    expect(byId.get('inbox-r2')).toMatchObject({ status: 'decided', decision: 'reject' });
  });
});
