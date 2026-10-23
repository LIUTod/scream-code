/// <reference types="vite/client" />
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, ServerEvent } from '../../../src/bot/shared/contracts';
import { setBotClient } from '../../../src/bot/ui/lib/api/client';
import { applyBotEvent } from '../../../src/bot/ui/lib/api/events';
import { HttpBotClient } from '../../../src/bot/ui/lib/api/http-client';
import { reconcileTranscript, transcriptGeneration, transcriptVersion, versionTranscript } from '../../../src/bot/ui/lib/api/message-state';
import { botQuery, messagesQuery, queryKeys, roomRunsQuery } from '../../../src/bot/ui/lib/api/queries';

const clients: QueryClient[] = [];
function cache(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return client;
}
function message(id: string, content: string): Message {
  return { id, content, threadId: 'thread', role: 'assistant', createdAt: null };
}
function delta(value: Message, version: number): ServerEvent {
  return { epoch: 'process', seq: version, type: 'assistant.delta', threadId: 'thread', botId: 'bot', data: { message: value, version } };
}

afterEach(() => {
  clients.splice(0).forEach((client) => { client.clear(); });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBotClient(new HttpBotClient());
});

describe('Bot live projection reconciliation', () => {
  it('upserts the first live delta before any transcript exists', () => {
    const client = cache();
    applyBotEvent(client, delta(message('live', 'first token'), 1));
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([message('live', 'first token')]);
  });

  it('preserves versions across successive deltas before a query observer mounts', async () => {
    const client = cache();
    applyBotEvent(client, delta(message('live', 'one'), 1));
    applyBotEvent(client, delta(message('live', 'one two'), 2));
    applyBotEvent(client, delta(message('live', 'one two three'), 3));
    expect(transcriptVersion(client.getQueryData<Message[]>(queryKeys.messages('thread')))).toBe(3);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ epoch: 'process', threadId: 'thread', version: 1, messages: [message('live', 'one')] })));
    setBotClient(new HttpBotClient());
    await client.fetchQuery(messagesQuery('thread'));
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([message('live', 'one two three')]);
  });

  it('does not replace a newer message or lose a live-only message to an older HTTP snapshot', async () => {
    const client = cache();
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    setBotClient(new HttpBotClient());
    const fetching = client.fetchQuery(messagesQuery('thread'));
    applyBotEvent(client, delta(message('live', 'new cumulative text'), 4));
    pending.resolve(Response.json({ epoch: 'process', threadId: 'thread', version: 2, messages: [message('history', 'old history'), message('live', 'new')] }));
    await fetching;
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([
      message('history', 'old history'), message('live', 'new cumulative text'),
    ]);
    expect(transcriptVersion(client.getQueryData<Message[]>(queryKeys.messages('thread')))).toBe(4);
  });

  it('guards the cache-write microtask race, not just the HTTP read boundary', async () => {
    const client = cache();
    const transport = new HttpBotClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ epoch: 'process', threadId: 'thread', version: 1, messages: [] })));
    const oldResponse = await transport.listMessages('thread');
    client.setQueryDefaults(['messages'], { structuralSharing: (old, incoming) => reconcileTranscript(old as Message[] | undefined, incoming as Message[]) });
    applyBotEvent(client, delta(message('live', 'already delivered'), 2));
    client.setQueryData(queryKeys.messages('thread'), oldResponse);
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([message('live', 'already delivered')]);
  });

  it('keeps full tool state and rejects out-of-order live versions', async () => {
    const client = cache();
    client.setQueryDefaults(['messages'], { structuralSharing: (old, incoming) => reconcileTranscript(old as Message[] | undefined, incoming as Message[]) });
    applyBotEvent(client, delta(message('live', 'completed text'), 5));
    const withTool: Message = { ...message('live', 'completed text'), toolCalls: [{ id: 'tool', name: 'Read', status: 'done', startedAt: 1, endedAt: 2 }] };
    applyBotEvent(client, { ...delta(withTool, 6), type: 'tool.updated' });
    applyBotEvent(client, delta(message('live', 'older'), 4));
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([withTool]);
    expect(transcriptVersion(client.getQueryData<Message[]>(queryKeys.messages('thread')))).toBe(6);
    await client.cancelQueries();
  });

  it('accepts a newer authoritative snapshot and preserves the unversioned mock contract', () => {
    const old = versionTranscript([message('live', 'working')], 1);
    const newer = versionTranscript([message('live', 'finished')], 2);
    expect(reconcileTranscript(old, newer)).toBe(newer);
    const mock = [message('live', 'mock updated')];
    expect(reconcileTranscript(old, mock)).toBe(old);
    const client = cache();
    applyBotEvent(client, { epoch: 'mock', seq: 1, type: 'assistant.delta', threadId: 'thread', data: { messageId: 'mock-message', content: 'first mock token' } });
    expect(client.getQueryData<Message[]>(queryKeys.messages('thread'))?.[0]).toMatchObject({ id: 'mock-message', content: 'first mock token', createdAt: null });
  });

  it('does not erase a known version stamp with an unversioned live payload', () => {
    const client = cache();
    applyBotEvent(client, delta(message('live', 'known version'), 4));
    applyBotEvent(client, { epoch: 'process', seq: 5, type: 'assistant.delta', threadId: 'thread', data: { messageId: 'live', content: 'unversioned' } });
    const stored = client.getQueryData<Message[]>(queryKeys.messages('thread'));
    expect(stored).toEqual([message('live', 'known version')]);
    expect(transcriptVersion(stored)).toBe(4);
  });

  it('compares message projection versions even if the snapshot envelope was captured later', () => {
    const live = { ...message('live', 'newest content'), projectionVersion: 4 };
    const existing = versionTranscript([live], 4);
    const snapshot = versionTranscript([{ ...message('live', 'older content'), projectionVersion: 2 }], 5);
    expect(reconcileTranscript(existing, snapshot)).toEqual([live]);
  });

  it('accepts lower projection versions after a process restart without accepting late old-process responses', () => {
    const oldProcess = transcriptGeneration('old-generation');
    const newProcess = transcriptGeneration('new-generation');
    const previous = versionTranscript([message('live', 'pre-crash overlay')], 900, oldProcess);
    const restarted = versionTranscript([message('live', 'recovered truth')], 2, newProcess);
    expect(reconcileTranscript(previous, restarted)).toBe(restarted);
    const late = versionTranscript([message('live', 'stale pre-crash response'), message('old-only', 'must not reappear')], 899, oldProcess);
    expect(reconcileTranscript(restarted, late)).toBe(restarted);
  });

  it('invalidates every reconciliation domain, including file previews and handoffs', () => {
    const client = cache();
    const domains = ['bots', 'bot', 'threads', 'messages', 'runs', 'inbox', 'handoffs', 'rooms', 'room-messages', 'room-runs', 'activity', 'files', 'file'];
    for (const domain of domains) client.setQueryData([domain, 'nested'], []);
    applyBotEvent(client, { epoch: 'restart', seq: 0, type: 'resync', data: { reason: 'epoch_mismatch' } });
    for (const domain of domains) expect(client.getQueryState([domain, 'nested'])?.isInvalidated, domain).toBe(true);
  });

  it('refreshes final-run domains and open file content, not only file lists', () => {
    const client = cache();
    const keys = [queryKeys.messages('thread'), queryKeys.file('bot', '/file', 'thread'), queryKeys.files('bot', '/dir', 'thread'), queryKeys.runs(), queryKeys.inbox(), queryKeys.activity(), queryKeys.handoffs()];
    for (const key of keys) client.setQueryData(key, []);
    applyBotEvent(client, { epoch: 'process', seq: 8, type: 'run.updated', botId: 'bot', threadId: 'thread', data: {} });
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
});

describe('transcript response epoch ordering', () => {
  it('accepts a lower version after REST-only restart and retires the old epoch', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ epoch: 'rest-before', threadId: 'thread', version: 900, messages: [message('old-only', 'before restart')] }))
      .mockResolvedValueOnce(Response.json({ epoch: 'rest-after', threadId: 'thread', version: 1, messages: [message('live', 'recovered')] }))
      .mockResolvedValueOnce(Response.json({ epoch: 'rest-before', threadId: 'thread', version: 901, messages: [message('extra-old', 'must not revive')] }));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    const before = await transport.listMessages('thread');
    const after = await transport.listMessages('thread');
    expect(reconcileTranscript(before, after)).toBe(after);
    expect(after).toEqual([message('live', 'recovered')]);
    await expect(transport.listMessages('thread')).rejects.toThrow('Stale transcript epoch');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(transport.getConnectionState().status).toBe('disconnected');
  });

  it('does not register an unknown old epoch from an earlier request that arrives last', async () => {
    const old = Promise.withResolvers<Response>();
    const current = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
    const transport = new HttpBotClient();
    const first = transport.listMessages('thread');
    const second = transport.listMessages('thread');
    current.resolve(Response.json({ epoch: 'latest-rest', threadId: 'thread', version: 1, messages: [message('live', 'current')] }));
    const accepted = await second;
    old.resolve(Response.json({ epoch: 'never-observed-old-rest', threadId: 'thread', version: 999, messages: [message('old-only', 'late')] }));
    await expect(first).rejects.toThrow('Stale transcript epoch');
    expect(accepted).toEqual([message('live', 'current')]);
  });

  it('fences every in-flight request at acceptance, then rediscovers a concurrent restart on the next poll', async () => {
    const first = Promise.withResolvers<Response>();
    const concurrent = Promise.withResolvers<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(concurrent.promise)
      .mockResolvedValueOnce(Response.json({ epoch: 'concurrent-new', threadId: 'thread', version: 1, messages: [] }));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    const earlier = transport.listMessages('thread');
    const later = transport.listMessages('thread');
    first.resolve(Response.json({ epoch: 'concurrent-old', threadId: 'thread', version: 50, messages: [] }));
    await earlier;
    concurrent.resolve(Response.json({ epoch: 'concurrent-new', threadId: 'thread', version: 1, messages: [] }));
    await expect(later).rejects.toThrow('Stale transcript epoch');
    await expect(transport.listMessages('thread')).resolves.toEqual([]);
  });

  it('rejects first-REST old data after the first new-SSE checkpoint', async () => {
    const old = Promise.withResolvers<Response>();
    const stream = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"epoch":"sse-first-new","seq":0}\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(stream));
    const transport = new HttpBotClient();
    const pending = transport.listMessages('thread');
    const events: ServerEvent[] = [];
    const stop = transport.subscribe((event) => events.push(event));
    try {
      await vi.waitFor(() => { expect(events[0]?.epoch).toBe('sse-first-new'); });
      old.resolve(Response.json({ epoch: 'unknown-first-rest-old', threadId: 'thread', version: 400, messages: [message('old-only', 'late')] }));
      await expect(pending).rejects.toThrow('Stale transcript epoch');
    } finally { stop(); }
  });

  it('fences a resolved HTTP array at SSE cache-write time without reviving old-only IDs', () => {
    const client = cache();
    client.setQueryDefaults(['messages'], { structuralSharing: (old, incoming) => reconcileTranscript(old as Message[] | undefined, incoming as Message[]) });
    const oldGeneration = transcriptGeneration('resolved-old');
    const live = { ...message('live', 'pre-crash overlay'), projectionVersion: 800 };
    const late = versionTranscript([live, message('old-only', 'late old history')], 800, oldGeneration);
    client.setQueryData(queryKeys.messages('thread'), versionTranscript([live], 800, oldGeneration));
    applyBotEvent(client, { epoch: 'resolved-new', seq: 0, type: 'resync', data: { reason: 'snapshot' } });
    client.setQueryData(queryKeys.messages('thread'), late);
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([live]);
    const recovered = { ...message('live', 'recovered truth'), projectionVersion: 1 };
    client.setQueryData(queryKeys.messages('thread'), versionTranscript([recovered], 1, transcriptGeneration('resolved-new')));
    expect(client.getQueryData(queryKeys.messages('thread'))).toEqual([recovered]);
  });

  it('merges unseen genuine history from an older same-epoch snapshot while retaining live text and context', () => {
    const generation = transcriptGeneration('same-epoch');
    const live = { ...message('live', 'all tokens'), projectionVersion: 9, runId: 'run', turnId: 2, stepId: 'step', coreMessageId: 'core', origin: { kind: 'web' } };
    const existing = versionTranscript([live], 9, generation);
    const incoming = versionTranscript([message('history', 'real history'), { ...live, content: 'all', projectionVersion: 3 }], 3, generation);
    const merged = reconcileTranscript(existing, incoming);
    expect(merged).toEqual([message('history', 'real history'), live]);
    expect(merged[1]).toBe(live);
    expect(transcriptVersion(merged)).toBe(9);
  });

  it('requires a valid response epoch even when no SSE has connected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ threadId: 'thread', version: 1, messages: [] })));
    await expect(new HttpBotClient().listMessages('thread')).rejects.toThrow('Invalid transcript snapshot');
  });
});

describe('Bot HTTP query contracts', () => {
  it('represents an absent Bot as null without rejecting undefined query data', async () => {
    const client = cache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([])));
    setBotClient(new HttpBotClient());
    await expect(client.fetchQuery(botQuery('missing'))).resolves.toBeNull();
    expect(client.getQueryState(queryKeys.bot('missing'))?.status).toBe('success');
  });

  it('retains genuine network errors without treating them as deletion or looping retries', async () => {
    const client = cache();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetcher);
    setBotClient(new HttpBotClient());
    await expect(client.fetchQuery(botQuery('bot'))).rejects.toThrow('offline');
    expect(client.getQueryState(queryKeys.bot('bot'))?.status).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the coordinated cancel/recovery routes and unwraps the accepted retry run', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'queued', status: 'cancelled' }))
      .mockResolvedValueOnce(Response.json({ run: { id: 'interrupted' }, retryRun: { id: 'retry-run' } }))
      .mockResolvedValueOnce(Response.json({ run: { id: 'interrupted' }, retryRun: null }));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    await expect(transport.cancelRun('queued')).resolves.toBeUndefined();
    await expect(transport.recoverRun('interrupted', 'retry')).resolves.toEqual({ runId: 'retry-run' });
    await expect(transport.recoverRun('interrupted', 'continue_queue')).resolves.toEqual({});
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/runs/queued/cancel');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/runs/interrupted/recovery');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"decision":"retry"}' });
  });

  it('forwards the approved room request key without inventing or retrying requests', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ runId: 'room-run' }))
      .mockResolvedValueOnce(Response.json({ runId: 'room-run' }))
      .mockRejectedValueOnce(new TypeError('response lost'));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    await transport.promptRoom('room/a', 'accepted task', 'room-request');
    await transport.promptRoom('room/a', 'no explicit key');
    await expect(transport.promptRoom('room/a', 'uncertain original task', 'same-request')).rejects.toThrow('response lost');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/rooms/room%2Fa/messages');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"text":"accepted task","requestKey":"room-request"}' });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"text":"no explicit key"}' });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: '{"text":"uncertain original task","requestKey":"same-request"}' });
  });

  it('unwraps PATCH bot state while retaining config-application fields on threads', async () => {
    const saved = { id: 'bot', name: 'Saved' };
    const threads = [{ id: 'thread', configApplyState: 'failed', configApplyError: 'provider unavailable' }];
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ bot: saved, config: { state: 'partial' } }))
      .mockResolvedValueOnce(Response.json(threads));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    await expect(transport.updateBot('bot', { name: 'Saved' })).resolves.toEqual(saved);
    await expect(transport.listThreads('bot')).resolves.toEqual(threads);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH', body: '{"name":"Saved"}' });
  });

  it('extracts room message/run arrays from the shared GET envelope and refreshes room runs', async () => {
    const messages = [{ id: 'room-message', roomId: 'room/a', content: 'task' }];
    const runs = [{ id: 'room-run', roomId: 'room/a', threadId: 'thread', status: 'queued' }];
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ messages, runs })));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    setBotClient(transport);
    await expect(transport.listRoomMessages('room/a')).resolves.toEqual(messages);
    const client = cache();
    await expect(client.fetchQuery(roomRunsQuery('room/a'))).resolves.toEqual(runs);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/rooms/room%2Fa/messages', '/api/rooms/room%2Fa/messages']);
    applyBotEvent(client, { epoch: 'room-process', seq: 1, type: 'run.updated', roomId: 'room/a', data: { run: runs[0] } });
    expect(client.getQueryState(queryKeys.roomRuns('room/a'))?.isInvalidated).toBe(true);
  });

  it('preserves directory and truncated-file response metadata', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ path: '/workspace/sub', entries: [{ name: 'a.txt', path: '/workspace/sub/a.txt', type: 'file', size: 20 }] }))
      .mockResolvedValueOnce(Response.json({ path: '/workspace/sub/a.txt', content: 'partial', truncated: true }));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    await expect(transport.listFiles('bot', 'sub', 'thread')).resolves.toEqual({ path: '/workspace/sub', entries: [{ path: '/workspace/sub/a.txt', kind: 'file', size: 20 }] });
    await expect(transport.readFile('bot', 'sub/a.txt', 'thread')).resolves.toEqual({ path: '/workspace/sub/a.txt', content: 'partial', truncated: true });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/bots/bot/files?path=sub&threadId=thread');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/bots/bot/files?path=sub%2Fa.txt&threadId=thread');
  });
});
