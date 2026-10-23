import { describe, expect, it, vi } from 'vitest';
import { createRuntimeFixture } from './fakes';

function setup() {
  const fixture = createRuntimeFixture();
  const bot = fixture.store.createBot({ name: 'A', workspace: process.cwd() });
  const thread = fixture.store.createThread(bot.id);
  return { ...fixture, bot, thread };
}

describe('SDK scheduling regression', () => {
  it('does not dispatch queued input when prompt RPC resolves before the turn ends', async () => {
    const f = setup();
    f.runtime.prompt(f.thread.id, { text: 'first' });
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['first']); });
    f.runtime.prompt(f.thread.id, { text: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['first']);
    await f.runtime.close();
  });

  it('does not let a child turn overwrite text or finish its parent run', async () => {
    const f = setup();
    const run = f.runtime.prompt(f.thread.id, { text: 'parent' });
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['parent']); });
    const session = f.factory.sessionFor(f.thread.id);
    session.emit({ type: 'assistant.delta', sessionId: session.id, agentId: 'child_1', turnId: 1, delta: 'private child text' });
    session.emit({ type: 'turn.ended', sessionId: session.id, agentId: 'child_1', turnId: 1, reason: 'completed' });
    expect(f.store.getRun(run.runId)?.status).toBe('running');
    expect((await f.runtime.hydrate(f.thread.id)).map((m) => m.content)).toEqual(['parent']);
    await f.runtime.close();
  });
});

describe('turn ownership boundaries', () => {
  it('observes a scheduled main turn without stealing the web awaiting latch', async () => {
    const f = setup();
    const session = await f.factory.open(f.bot,f.thread);
    vi.spyOn(session,'prompt').mockImplementation(async () => {
      session.emit({type:'turn.started',sessionId:session.id,agentId:'main',turnId:10,origin:{kind:'system_trigger',name:'notification'}});
    });
    const web = f.runtime.prompt(f.thread.id,{text:'web input'});
    await vi.waitFor(() => { expect(f.store.listRunsForThread(f.thread.id)).toHaveLength(2); });
    const observed = f.store.listRunsForThread(f.thread.id).find((run) => run.kind==='observed')!;
    expect(f.store.getRun(web.runId)?.turnId).toBeNull();
    session.emit({type:'turn.ended',sessionId:session.id,agentId:'main',turnId:10,reason:'completed'});
    expect(f.store.getRun(observed.id)?.status).toBe('interrupted');
    // Real SDK prompt becomes a steer when a scheduled turn wins the race;
    // there will NOT be another user turn.started to release the old latch.
    await vi.waitFor(() => { expect(f.store.getRun(web.runId)?.status).toBe('interrupted'); });
    expect(f.store.getRun(web.runId)?.turnId).toBeNull();
    expect(f.store.getThread(f.thread.id)?.blockedByRunId).toBe(web.runId);
    await f.runtime.close();
  });

  it('pauses dispatch without cancelling accepted queue entries and blocks deletion races', async () => {
    const f = setup();
    const first = f.runtime.prompt(f.thread.id,{text:'first'});
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['first']); });
    const queued = f.runtime.prompt(f.thread.id,{text:'second'});
    f.store.setBotPaused(f.bot.id,true);
    f.factory.sessionFor(f.thread.id).complete('first done');
    await vi.waitFor(() => { expect(f.store.getRun(first.runId)?.status).toBe('done'); });
    await new Promise((resolve) => setTimeout(resolve,10));
    expect(f.store.getRun(queued.runId)?.status).toBe('queued');
    f.store.setBotPaused(f.bot.id,false);
    f.runtime.kickQueue();
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['first','second']); });
    const deletion = f.runtime.deleteThread(f.thread.id);
    expect(() => f.runtime.prompt(f.thread.id,{text:'racing'})).toThrow(/deleted/);
    await deletion;
    expect(f.store.getRun(queued.runId)).toBeUndefined();
    expect(f.store.listThreads(f.bot.id)).toHaveLength(1);
    await f.runtime.close();
  });
});

describe('live session residency', () => {
  it('does not idle-close observed turns, active background work or resident schedules', async () => {
    vi.useFakeTimers();
    let clock = 1;
    const f = createRuntimeFixture({idleMinutes:0.001,now:() => clock});
    const bot = f.store.createBot({name:'Resident',workspace:process.cwd()});
    const thread = f.store.createThread(bot.id);
    f.store.updateThread(thread.id,{coreSessionId:'resident-core'});
    try {
      await f.runtime.hydrate(thread.id);
      const session = f.factory.sessionFor(thread.id);
      const background = vi.spyOn(session,'listBackgroundTasks').mockResolvedValue([{}]);
      const schedules = vi.spyOn(session,'listCronTasks').mockResolvedValue([]);
      clock = 10000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.closed).toBe(false);
      background.mockResolvedValue([]);
      schedules.mockResolvedValue([{nextFireAt:20000}]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.closed).toBe(false);
      schedules.mockResolvedValue([]);
      session.emit({type:'turn.started',sessionId:session.id,agentId:'main',turnId:100,origin:{kind:'system_trigger',name:'notification'}});
      clock = 20000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.closed).toBe(false);
      session.emit({type:'turn.ended',sessionId:session.id,agentId:'main',turnId:100,reason:'completed'});
      await vi.advanceTimersByTimeAsync(1);
      clock = 30000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.closed).toBe(true);
    } finally {
      await f.runtime.close();
      vi.useRealTimers();
    }
  });
});
