// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBotClient } from '../../../src/bot/ui/lib/api/client';
import { useBotConnectionState } from '../../../src/bot/ui/lib/api/events';
import { HttpBotClient } from '../../../src/bot/ui/lib/api/http-client';
import { MockBotClient } from '../../../src/bot/ui/lib/mock/mock-client';

const stops: (() => void)[] = [];
afterEach(() => {
  act(() => { stops.splice(0).forEach((stop) => { stop(); }); });
  cleanup();
  vi.unstubAllGlobals();
  setBotClient(new HttpBotClient());
});

describe('Bot connection hook', () => {
  it('reports local only for a local client', () => {
    setBotClient(new MockBotClient());
    const local = renderHook(() => useBotConnectionState());
    expect(local.result.current).toEqual({ status: 'local', error: null, retryInMs: null });
    local.unmount();
    setBotClient(new HttpBotClient());
    const http = renderHook(() => useBotConnectionState());
    expect(http.result.current).toEqual({ status: 'disconnected', error: null, retryInMs: null });
  });

  it('keeps permanent stream errors visible without a retry or local fallback', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const transport = new HttpBotClient();
    setBotClient(transport);
    const hook = renderHook(() => useBotConnectionState());
    act(() => { stops.push(transport.subscribe(() => {})); });
    await waitFor(() => { expect(hook.result.current.status).toBe('error'); });
    expect(hook.result.current.error).toContain('401');
    expect(hook.result.current.retryInMs).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('exposes transient errors and clears the retry when the stream is stopped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network offline')));
    const transport = new HttpBotClient();
    setBotClient(transport);
    const hook = renderHook(() => useBotConnectionState());
    let stop = () => {};
    act(() => { stop = transport.subscribe(() => {}); stops.push(stop); });
    await waitFor(() => { expect(hook.result.current.status).toBe('offline'); });
    expect(hook.result.current).toMatchObject({ error: 'network offline', retryInMs: 1_000 });
    act(() => { stop(); });
    expect(hook.result.current).toEqual({ status: 'disconnected', error: null, retryInMs: null });
  });
});
