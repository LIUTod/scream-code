import { describe, expect, it, vi } from 'vitest';
import { createRuntimeFixture } from './fakes';

function setup() {
  const f = createRuntimeFixture();
  const bot = f.store.createBot({name:'A',workspace:process.cwd()});
  const thread = f.store.createThread(bot.id);
  return {...f,bot,thread};
}

describe('durable queue recovery', () => {
  it('restarts only complete undispatched inputs and blocks only uncertain threads', async () => {
    const f = setup();
    const blocked = f.store.createRun({botId:f.bot.id,threadId:f.thread.id,text:'uncertain',requestKey:'uncertain'});
    f.store.markDispatch(blocked.id,'old-session','old-generation');
    const waiting = f.store.createRun({botId:f.bot.id,threadId:f.thread.id,text:'later',requestKey:'later'});
    const other = f.store.createThread(f.bot.id);
    const safe = f.store.createRun({botId:f.bot.id,threadId:other.id,text:'safe',requestKey:'safe'});
    f.runtime.start();
    expect(f.store.getRun(blocked.id)?.status).toBe('interrupted');
    expect(f.store.getThread(f.thread.id)?.blockedByRunId).toBe(blocked.id);
    await vi.waitFor(() => { expect(f.factory.sessionFor(other.id).prompts).toEqual(['safe']); });
    expect(f.store.getRun(safe.id)?.status).toBe('running');
    expect(f.store.getRun(waiting.id)?.status).toBe('queued');
    const first = f.runtime.recoverRun(blocked.id,'continue_queue');
    expect(f.runtime.recoverRun(blocked.id,'continue_queue')).toEqual(first);
    expect(() => f.runtime.recoverRun(blocked.id,'retry')).toThrow(/already recorded/);
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['later']); });
    expect(f.store.getRun(blocked.id)?.status).toBe('interrupted');
    await f.runtime.close();
  });

  it('retry is atomic and idempotent; cancel_queue does not rewrite interrupted history', async () => {
    const f = setup();
    const original = f.store.createRun({botId:f.bot.id,threadId:f.thread.id,text:'do work'});
    f.store.updateRunStatus(original.id,'running');
    f.store.markOrphanRuns();
    f.store.setBotPaused(f.bot.id,true);
    const first = f.runtime.recoverRun(original.id,'retry');
    const second = f.runtime.recoverRun(original.id,'retry');
    expect(first.retryRun?.retryOfRunId).toBe(original.id);
    expect(second.retryRun?.id).toBe(first.retryRun?.id);
    expect(f.store.listRunsForThread(f.thread.id)).toHaveLength(2);
    const other = f.store.createThread(f.bot.id);
    const unknown = f.store.createRun({botId:f.bot.id,threadId:other.id,text:'unknown'});
    f.store.updateRunStatus(unknown.id,'running');
    const pending = f.store.createRun({botId:f.bot.id,threadId:other.id,text:'queued'});
    f.store.markOrphanRuns();
    f.runtime.recoverRun(unknown.id,'cancel_queue');
    expect(f.store.getRun(pending.id)?.status).toBe('cancelled');
    expect(f.store.getRun(unknown.id)?.status).toBe('interrupted');
    expect(f.store.getThread(other.id)?.blockedByRunId).toBeNull();
    await f.runtime.close();
  });

  it('deduplicates persisted request keys, including active-run steer inputs', async () => {
    const f = setup();
    const first = f.runtime.prompt(f.thread.id,{text:'one',requestKey:'request-one'});
    expect(f.runtime.prompt(f.thread.id,{text:'one',requestKey:'request-one'}).runId).toBe(first.runId);
    expect(() => f.runtime.prompt(f.thread.id,{text:'different',requestKey:'request-one'})).toThrow(/different input/);
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['one']); });
    f.runtime.prompt(f.thread.id,{text:'adjust',mode:'steer',requestKey:'request-steer'});
    f.runtime.prompt(f.thread.id,{text:'adjust',mode:'steer',requestKey:'request-steer'});
    expect(f.factory.sessionFor(f.thread.id).steers).toEqual(['adjust']);
    expect(f.store.listMessages(f.thread.id).filter((m) => m.content==='adjust')).toHaveLength(1);
    await f.runtime.close();
  });

  it('cancel acknowledgement is not turn completion; unknown outcome requires recovery', async () => {
    const f = setup();
    const run = f.runtime.prompt(f.thread.id,{text:'active'});
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['active']); });
    const session = f.factory.sessionFor(f.thread.id);
    vi.spyOn(session,'cancel').mockResolvedValue(undefined);
    f.runtime.prompt(f.thread.id,{text:'pending'});
    await f.runtime.interrupt(f.thread.id);
    expect(f.store.getRun(run.runId)?.status).toBe('running');
    expect(session.prompts).toEqual(['active']);
    vi.spyOn(session,'cancel').mockRejectedValue(new Error('disconnected'));
    await f.runtime.interrupt(f.thread.id);
    expect(f.store.getRun(run.runId)?.status).toBe('interrupted');
    expect(f.store.getThread(f.thread.id)?.blockedByRunId).toBe(run.runId);
    expect(session.closed).toBe(true);
    session.emit({type:'turn.ended',sessionId:session.id,agentId:'main',turnId:1,reason:'completed'});
    expect(f.store.getRun(run.runId)?.status).toBe('interrupted');
    await f.runtime.close();
  });

  it('rejects forged attachment paths and can cancel individual queued items', async () => {
    const f = setup();
    expect(() => f.runtime.prompt(f.thread.id,{text:'file',attachments:[{id:'a',name:'a.txt',path:'../evil.txt',size:3,mime:'text/plain'}]})).toThrow(/not an uploaded file/);
    const run = f.runtime.prompt(f.thread.id,{text:'never start'});
    expect(f.runtime.cancelQueuedRun(run.runId).status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve,10));
    expect(f.factory.openCalls).toEqual([]);
    await f.runtime.close();
  });
});
