import { describe, expect, it, vi } from 'vitest';
import { BotRuntime } from '../../../src/bot/server/runtime';
import { answerForRun } from '../../../src/bot/server/transcript';
import { contextMessage, createRuntimeFixture, FakeSession } from './fakes';

describe('run-scoped answers', () => {
  const message = (id: string, runId: string | undefined, content: string) => ({ id, role: 'assistant' as const, content, createdAt: 1, runId });

  it('selects the answer of its own run even when a newer answer exists', () => {
    const messages = [message('a','run_1','first answer'), message('b','run_2','second answer')] as never;
    expect(answerForRun(messages,'run_1')).toBe('first answer');
    expect(answerForRun(messages,'run_2')).toBe('second answer');
  });

  it('falls back to the newest answer when runs are untagged', () => {
    const messages = [message('a',undefined,'legacy one'), message('b',undefined,'legacy two')] as never;
    expect(answerForRun(messages,'run_x')).toBe('legacy two');
  });
});

function setup() {
  const f = createRuntimeFixture();
  const bot = f.store.createBot({name:'A',workspace:process.cwd()});
  const thread = f.store.createThread(bot.id);
  return {...f,bot,thread};
}

describe('shared durable transcript projection', () => {
  it('initializes old SDK history before dispatching immediately submitted cold input', async () => {
    const f = setup();
    const session = new FakeSession('core-cold',[contextMessage('user','old',{id:'m1'}),contextMessage('assistant','old answer',{id:'m2'})]);
    f.factory.sessions.set(f.thread.id,session);
    f.store.updateThread(f.thread.id,{coreSessionId:session.id});
    let release!: () => void;
    const context = session.getContext.bind(session);
    const baseline = vi.spyOn(session,'getContext').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {release=resolve;});
      return context();
    });
    f.runtime.prompt(f.thread.id,{text:'new'});
    const snapshot = f.runtime.transcriptSnapshot(f.thread.id);
    await vi.waitFor(() => { expect(baseline).toHaveBeenCalledTimes(1); });
    expect(session.prompts).toEqual([]);
    release();
    const hydrated = await snapshot;
    expect(hydrated.messages.map((m) => m.content)).toEqual(['old','old answer','new']);
    expect(hydrated.messages[0]?.createdAt).toBeNull();
    await vi.waitFor(() => { expect(session.prompts).toEqual(['new']); });
    session.complete('new answer');
    await f.runtime.close();
  });

  it('REST contains cumulative streamed text and running tool state; final aliases remain stable', async () => {
    const f = setup();
    f.runtime.prompt(f.thread.id,{text:'work'});
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['work']); });
    const session = f.factory.sessionFor(f.thread.id);
    const base = {sessionId:session.id,agentId:'main',turnId:1};
    session.emit({...base,type:'assistant.delta',delta:'partial'});
    const first = await f.runtime.transcriptSnapshot(f.thread.id);
    const live = first.messages.find((m) => m.role==='assistant')!;
    session.emit({...base,type:'assistant.delta',delta:' more'});
    session.emit({...base,type:'tool.call.started',toolCallId:'read',name:'Read',args:{path:'a'}});
    const second = await f.runtime.transcriptSnapshot(f.thread.id);
    expect(second.version).toBeGreaterThan(first.version);
    expect(second.messages.find((m) => m.id===live.id)).toMatchObject({content:'partial more',toolCalls:[{id:'read',status:'running'}]});
    session.emit({...base,type:'tool.result',toolCallId:'read',output:'contents'});
    session.history.push(contextMessage('assistant','partial more',{id:'m2',toolCalls:[{type:'function',id:'read',name:'Read',arguments:'{"path":"a"}'}]}));
    session.history.push(contextMessage('tool','contents',{id:'m3',toolCallId:'read'}));
    session.emit({...base,type:'turn.ended',reason:'cancelled'});
    await vi.waitFor(async () => { expect((await f.runtime.hydrate(f.thread.id)).find((m) => m.id===live.id)?.coreMessageId).toBe('m2'); });
    const final = await f.runtime.transcriptSnapshot(f.thread.id);
    expect(final.messages.filter((m) => m.role==='assistant')).toHaveLength(1);
    expect(final.messages.find((m) => m.id===live.id)?.toolCalls?.[0]).toMatchObject({status:'done',output:'contents'});
    await f.runtime.close();
    const restored = new BotRuntime({store:f.store,hub:f.hub,sessions:f.factory});
    const after = await restored.transcriptSnapshot(f.thread.id);
    expect(after.messages.map((m) => m.id)).toEqual(final.messages.map((m) => m.id));
    expect(after.version).toBeGreaterThanOrEqual(final.version);
    await restored.close();
  });

  it('does not deduplicate repeated text and retains displayed history through compaction', async () => {
    const f = setup();
    f.runtime.prompt(f.thread.id,{text:'same'});
    await vi.waitFor(() => { expect(f.factory.sessionFor(f.thread.id).prompts).toEqual(['same']); });
    const session = f.factory.sessionFor(f.thread.id);
    session.complete('same');
    await vi.waitFor(async () => { expect(await f.runtime.hydrate(f.thread.id)).toHaveLength(2); });
    f.runtime.prompt(f.thread.id,{text:'same'});
    await vi.waitFor(() => { expect(session.prompts).toHaveLength(2); });
    session.complete('same');
    await vi.waitFor(async () => { expect(await f.runtime.hydrate(f.thread.id)).toHaveLength(4); });
    const before = await f.runtime.hydrate(f.thread.id);
    expect(new Set(before.map((m) => m.id)).size).toBe(4);
    session.history.splice(0,2);
    expect((await f.runtime.hydrate(f.thread.id)).map((m) => m.id)).toEqual(before.map((m) => m.id));
    await f.runtime.close();
  });
});
