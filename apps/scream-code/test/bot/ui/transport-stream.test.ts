/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBotClient } from '../../../src/bot/ui/lib/api/http-client';
import { BotSseParser, type SseFrame } from '../../../src/bot/ui/lib/api/transport';
import type { ServerEvent } from '../../../src/bot/shared/contracts';

const encoder = new TextEncoder();
function frame(event: Partial<ServerEvent> & { seq: number }, id = `process:${String(event.seq)}`): string {
  return `id: ${id}\nevent: ${event.type ?? 'run.updated'}\ndata: ${JSON.stringify({ epoch: 'process', type: 'run.updated', data: {}, ...event })}\n\n`;
}
function response(text: string, close = true): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(text)); if (close) controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('incremental Bot SSE parser', () => {
  it('parses partial UTF-8, split CRLF delimiters, multiline data and cursor resets', () => {
    const frames: SseFrame[] = [];
    const parser = new BotSseParser((value) => frames.push(value));
    const bytes = encoder.encode(': heartbeat\r\nid: process:1\r\nevent: assistant.delta\r\ndata: 你好\r\ndata: world\r\n\r\nid:\n\ndata: tail\n\n');
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    expect(frames).toEqual([
      { id: 'process:1', event: 'assistant.delta', data: '你好\nworld' },
      { id: '', event: 'message', data: '' },
      { id: undefined, event: 'message', data: 'tail' },
    ]);
  });

  it('dispatches a CR-only frame immediately, without waiting for another chunk', () => {
    const seen: SseFrame[] = [];
    const parser = new BotSseParser((value) => seen.push(value));
    parser.push(encoder.encode('data: one\r\r'));
    expect(seen).toEqual([{ event: 'message', id: undefined, data: 'one' }]);
    parser.push(encoder.encode('\ndata: two\r'));
    parser.push(encoder.encode('\r'));
    expect(seen.at(-1)?.data).toBe('two');
  });

  it('does not dispatch an incomplete frame or accept NUL ids', () => {
    const seen: SseFrame[] = [];
    const parser = new BotSseParser((value) => seen.push(value));
    parser.push(encoder.encode('id: a\0b\ndata: one\n'));
    expect(seen).toEqual([]);
    parser.push(encoder.encode('\n'));
    expect(seen).toEqual([{ id: undefined, event: 'message', data: 'one' }]);
  });
});

describe('HTTP Bot event transport', () => {
  it('preserves the cursor across clean EOF reconnects and stops aborted retries', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(response(frame({ seq: 1, botId: 'a' })))
      .mockResolvedValueOnce(response(frame({ seq: 2, botId: 'b' }), false));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpBotClient();
    const events: ServerEvent[] = [];
    const stop = client.subscribe((event) => events.push(event));
    await flush();
    expect(client.getConnectionState()).toMatchObject({ status: 'offline', retryInMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': 'process:1' });
    expect(events.map((event) => event.botId)).toEqual(['a', 'b']);
    expect(client.getConnectionState().status).toBe('connected');
    stop();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getConnectionState().status).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an explicit cursor reset and never spins on an ended stream', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(response(`${frame({ seq: 1 })}id:\n\n`))
      .mockResolvedValueOnce(response('', false));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpBotClient();
    const stop = client.subscribe(() => {});
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty('Last-Event-ID');
    stop();
    await flush();
  });

  it('uses bounded exponential backoff and clears a pending delay on stop', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpBotClient();
    const stop = client.subscribe(() => {});
    await flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      expect(client.getConnectionState()).toMatchObject({ status: 'offline', retryInMs: delay });
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(client.getConnectionState().retryInMs).toBe(30_000);
    const count = fetcher.mock.calls.length;
    stop();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it.each([
    [new Response('denied', { status: 401 }), '401'],
    [new Response('{}', { headers: { 'content-type': 'application/json' } }), 'text/event-stream'],
    [response('data: broken\n\n'), 'Invalid JSON'],
    [response('data: {"type":"run.updated"}\n\n'), 'watermark'],
    [response(frame({ seq: 1, type: 'assistant.delta', data: { message: {} } })), 'projection version'],
  ])('surfaces authorization/protocol failures without retrying', async (result, error) => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(result);
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpBotClient();
    const stop = client.subscribe(() => {});
    await flush();
    expect(client.getConnectionState()).toMatchObject({ status: 'error' });
    expect(client.getConnectionState().error).toContain(error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reconciles snapshots and epoch resets with the next reconnect cursor', async () => {
    vi.useFakeTimers();
    const snapshot = 'id: restarted:0\nevent: snapshot\ndata: {"epoch":"restarted","seq":0,"bots":[]}\n\n';
    const fetcher = vi.fn().mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response('', false));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpBotClient();
    const seen: ServerEvent[] = [];
    const stop = client.subscribe((event) => seen.push(event));
    await flush();
    expect(seen[0]).toMatchObject({ type: 'resync', epoch: 'restarted', seq: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': 'restarted:0' });
    stop();
    await flush();
  });

  it('shares one stream between subscribers and releases only after the last listener', async () => {
    const fetcher = vi.fn().mockResolvedValue(response('', false));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpBotClient();
    const stopOne = client.subscribe(() => {});
    const stopTwo = client.subscribe(() => {});
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    stopOne();
    expect(client.getConnectionState().status).toBe('connected');
    stopTwo();
    await flush();
    expect(client.getConnectionState().status).toBe('disconnected');
  });
});
