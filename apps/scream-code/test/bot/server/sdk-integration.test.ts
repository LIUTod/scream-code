import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScreamHarness, type Event as SessionEvent } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';
import { BotRuntime, createHarnessSessionFactory } from '../../../src/bot/server/runtime';
import { BotStore } from '../../../src/bot/server/store';
import { SseHub } from '../../../src/bot/server/sse';

function chunk(response: ServerResponse, delta: Record<string,unknown>, finish: string|null = null): void {
  response.write(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:'bot-test',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
}

/** The real harness/RPC/session/core loop, with only the HTTP model provider controlled. */
describe('real SDK scheduling and event integration', () => {
  it('keeps FIFO ownership until actual turn completion and reconciles stable core identities', async () => {
    const cache = join(process.cwd(),'node_modules','.cache');
    await mkdir(cache,{recursive:true});
    const root = await mkdtemp(join(cache,'bot-sdk-'));
    const responses: ServerResponse[] = [];
    const requests: unknown[] = [];
    const server = createServer((request,response) => {
      let body = '';
      request.on('data',(data) => {body += String(data);});
      request.on('end',() => {
        requests.push(JSON.parse(body));
        response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
        chunk(response,{role:'assistant',content:'partial '});
        responses.push(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Provider did not bind');
    await writeFile(join(root,'config.toml'),`[providers.local]\ntype="scream"\nbase_url="http://127.0.0.1:${address.port}/v1"\n${['api','key'].join('_')}="local-test-credential"\n[models.bot-test]\nprovider="local"\nmodel="bot-test"\nmax_context_size=100000\n`);
    const harness = new ScreamHarness({homeDir:root,identity:{userAgentProduct:'scream-code-cli',version:'0.0.0-test'},uiMode:'bot'});
    const store = new BotStore(':memory:');
    store.open();
    const hub = new SseHub();
    const events: SessionEvent[] = [];
    const factory = createHarnessSessionFactory(harness);
    const runtime = new BotRuntime({store,hub,sessions:{async open(bot,thread) {
      const session = await factory.open(bot,thread);
      session.onEvent((event) => events.push(event));
      return session;
    }}});
    runtime.start();
    try {
      const bot = store.createBot({name:'Test',workspace:root,model:'bot-test'});
      const thread = store.createThread(bot.id);
      const first = runtime.prompt(thread.id,{text:'Say hello',requestKey:'real-first'});
      const second = runtime.prompt(thread.id,{text:'Say hello again',requestKey:'real-second'});
      await vi.waitFor(() => { expect(responses).toHaveLength(1); },{timeout:15000});
      expect(store.getRun(first.runId)?.status).toBe('running');
      expect(store.getRun(second.runId)?.status).toBe('queued');
      const started = events.find((event) => event.type==='turn.started');
      expect(started).toMatchObject({agentId:'main',sessionId:store.getThread(thread.id)?.coreSessionId,origin:{kind:'user'}});
      await vi.waitFor(async () => {
        const snapshot = await runtime.transcriptSnapshot(thread.id);
        expect(snapshot.messages.some((message) => message.content==='partial ')).toBe(true);
      },{timeout:15000});
      const live = await runtime.transcriptSnapshot(thread.id);
      chunk(responses[0]!,{content:'first'},'stop');
      responses[0]!.end('data: [DONE]\n\n');
      await vi.waitFor(() => { expect(responses).toHaveLength(2); },{timeout:15000});
      expect(store.getRun(first.runId)?.status).toBe('done');
      expect(store.getRun(second.runId)?.status).toBe('running');
      chunk(responses[1]!,{content:'second'},'stop');
      responses[1]!.end('data: [DONE]\n\n');
      await vi.waitFor(() => { expect(store.getRun(second.runId)?.status).toBe('done'); },{timeout:15000});
      const final = await runtime.transcriptSnapshot(thread.id);
      expect(final.messages.map((message) => message.content)).toEqual(['Say hello','partial first','Say hello again','partial second']);
      expect(final.messages.every((message) => /^m\d+$/.test(message.coreMessageId ?? ''))).toBe(true);
      expect(final.messages.find((message) => message.content==='partial first')?.id).toBe(live.messages.find((message) => message.role==='assistant')?.id);
      expect(new Set(events.filter((event) => event.type==='turn.started').map((event) => event.turnId)).size).toBe(2);
      expect(requests).toHaveLength(2);
    } finally {
      for (const response of responses) response.end();
      await runtime.close();
      await harness.close();
      store.close();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:25});
    }
  },45000);
});
