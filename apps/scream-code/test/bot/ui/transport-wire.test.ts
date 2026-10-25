/// <reference types="vite/client" />
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../../src/bot/shared/contracts';
import { SseHub, eventId } from '../../../src/bot/server/sse';
import { HttpBotClient } from '../../../src/bot/ui/lib/api/http-client';

// Exercise the real fetch/ReadableStream/AbortController path over a loopback socket.
describe('Bot SSE wire transport', () => {
  it('does not resend a room POST after its accepted request loses the HTTP ACK', async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        if (received.length === 1) response.destroy();
        else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"runId":"accepted-run"}'); }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
    const client = new HttpBotClient(`http://127.0.0.1:${String(address.port)}`);
    try {
      await expect(client.promptRoom('room', 'original task', { requestKey: 'original-key' })).rejects.toThrow();
      expect(received).toEqual([{ text: 'original task', requestKey: 'original-key' }]);
      // Only an explicit caller retry may replay the original body and key.
      await client.promptRoom('room', 'original task', { requestKey: 'original-key' });
      expect(received).toEqual([
        { text: 'original task', requestKey: 'original-key' },
        { text: 'original task', requestKey: 'original-key' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
    }
  });

  it('closes a slow snapshot wire on bounded overflow and reconnects with an explicit gap', async () => {
    const hub = new SseHub({ epoch: 'slow-wire', pendingLimit: 1 });
    const cursors: (string | undefined)[] = [];
    let connections = 0;
    let firstSignal: AbortSignal | undefined;
    const server = createServer((request, response) => {
      const cursor = request.headers['last-event-id'];
      cursors.push(typeof cursor === 'string' ? cursor : undefined);
      connections += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      const subscription = hub.subscribe({
        lastEventId: typeof cursor === 'string' ? cursor : undefined,
        snapshot: (watermark, signal) => {
          if (connections === 1) { firstSignal = signal; return new Promise<void>(() => {}); }
          response.write(`event: snapshot\ndata: ${JSON.stringify(watermark)}\n\n`);
        },
      }, (event) => { response.write(`id: ${eventId(event)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
      response.on('close', subscription.unsubscribe);
      void subscription.ready.catch(() => { response.end(); });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
    const client = new HttpBotClient(`http://127.0.0.1:${String(address.port)}`);
    const seen: ServerEvent[] = [];
    const stop = client.subscribe((event) => seen.push(event));
    try {
      await vi.waitFor(() => { expect(firstSignal).toBeDefined(); });
      hub.publish({ botId: 'bot', type: 'run.updated', data: {} });
      hub.publish({ botId: 'bot', type: 'run.updated', data: {} });
      await vi.waitFor(() => { expect(seen.some((event) => (event.data as { reason?: string }).reason === 'pending_overflow')).toBe(true); });
      expect(firstSignal?.aborted).toBe(true);
      await vi.waitFor(() => { expect(connections).toBe(2); }, { timeout: 2_500 });
      expect(cursors).toEqual([undefined, 'slow-wire:2']);
      hub.publish({ botId: 'bot', type: 'run.updated', data: {} });
      await vi.waitFor(() => { expect(seen.filter((event) => event.type === 'run.updated').map((event) => event.seq)).toEqual([3]); });
    } finally {
      stop();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
    }
  });
  it('streams, stops, and replays multiple bots from the preserved global cursor', async () => {
    const hub = new SseHub({ epoch: 'wire-process' });
    const cursors: (string | undefined)[] = [];
    const publish = (botId: string) => hub.publish({ botId, type: 'run.updated', data: {} });
    publish('a');
    publish('b');
    const server = createServer((request, response) => {
      const lastEventId = request.headers['last-event-id'];
      const cursor = typeof lastEventId === 'string' ? lastEventId : undefined;
      cursors.push(cursor);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      const subscription = hub.subscribe({
        ...(cursor === undefined ? {} : { lastEventId: cursor }),
        snapshot: (watermark) => { response.write(`event: snapshot\ndata: ${JSON.stringify({ ...watermark, bots: [] })}\n\n`); },
      }, (event) => {
        const data = `id: ${eventId(event)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        response.write(data.slice(0, 7));
        response.write(data.slice(7));
      });
      response.on('close', subscription.unsubscribe);
      void subscription.ready.catch(() => { response.destroy(); });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
    const client = new HttpBotClient(`http://127.0.0.1:${String(address.port)}`);
    const seen: ServerEvent[] = [];
    let stop = client.subscribe((event) => seen.push(event));
    try {
      await vi.waitFor(() => { expect(seen.some((event) => event.type === 'resync')).toBe(true); });
      publish('a');
      publish('b');
      await vi.waitFor(() => { expect(seen.filter((event) => event.type === 'run.updated').map((event) => event.seq)).toEqual([3, 4]); });
      stop();
      await vi.waitFor(() => { expect(hub.subscriberCount).toBe(0); });
      publish('a');
      publish('b');
      seen.length = 0;
      stop = client.subscribe((event) => seen.push(event));
      await vi.waitFor(() => {
        expect(seen.filter((event) => event.type === 'run.updated').map((event) => [event.botId, event.seq])).toEqual([['a', 5], ['b', 6]]);
      });
      expect(cursors).toEqual([undefined, 'wire-process:4']);
      expect(client.getConnectionState().status).toBe('connected');
    } finally {
      stop();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
    }
    expect(hub.subscriberCount).toBe(0);
    expect(client.getConnectionState().status).toBe('disconnected');
  });
});
