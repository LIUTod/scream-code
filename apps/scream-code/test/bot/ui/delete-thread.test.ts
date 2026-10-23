/// <reference types="vite/client" />
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Thread } from '../../../src/bot/shared/contracts';
import { queryKeys } from '../../../src/bot/ui/lib/api/queries';
import {
  deleteBotThread,
  type DeleteThreadOperation,
  finishThreadDeletion,
} from '../../../src/bot/ui/lib/delete-thread';

const clients: QueryClient[] = [];

function queryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
}

function thread(botId: string, id: string): Thread {
  return { id, botId, title: '', lastActiveAt: 0, runStatus: null, unread: 0, archivedAt: null };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe('UI thread deletion', () => {
  it('keeps a pending A deletion owned by A when mutation options update on switching to B', async () => {
    const cache = queryClient();
    const originalA = thread('bot_a', 'thread_a');
    const originalB = thread('bot_b', 'thread_b');
    const replacement = thread('bot_a', 'thread_fresh');
    cache.setQueryData(queryKeys.threads('bot_a'), [originalA]);
    cache.setQueryData(queryKeys.threads('bot_b'), [originalB]);
    cache.setQueryData(queryKeys.messages(originalA.id), ['A transcript']);
    cache.setQueryData(queryKeys.messages(originalB.id), ['B transcript']);
    const deleting = Promise.withResolvers<void>();
    const listing = Promise.withResolvers<Thread[]>();
    const transport = {
      deleteThread: vi.fn(() => deleting.promise),
      listThreads: vi.fn(() => listing.promise),
      createThread: vi.fn(),
    };
    let pathname = '/bots/bot_a/threads/thread_a';
    const navigateToBot = vi.fn<(botId: string) => Promise<void>>().mockResolvedValue(undefined);
    const route = { getPathname: () => pathname, navigateToBot };
    const mutationFn = (operation: DeleteThreadOperation) => deleteBotThread(transport, operation);
    const firstSuccess = vi.fn((deleted: Awaited<ReturnType<typeof deleteBotThread>>) =>
      finishThreadDeletion(cache, deleted, route),
    );
    const observer = new MutationObserver(cache, { mutationFn, onSuccess: firstSuccess });
    const pending = observer.mutate({ botId: 'bot_a', threadId: originalA.id });
    await vi.waitFor(() => {
      expect(transport.deleteThread).toHaveBeenCalledWith(originalA.id);
    });

    pathname = '/bots/bot_b/threads/thread_b';
    const latestSuccess = vi.fn((deleted: Awaited<ReturnType<typeof deleteBotThread>>) =>
      finishThreadDeletion(cache, deleted, route),
    );
    observer.setOptions({ mutationFn, onSuccess: latestSuccess });
    deleting.resolve();
    await vi.waitFor(() => {
      expect(transport.listThreads).toHaveBeenCalledWith('bot_a');
    });
    listing.resolve([replacement]);
    await pending;

    expect(firstSuccess).not.toHaveBeenCalled();
    expect(latestSuccess).toHaveBeenCalledOnce();
    expect(cache.getQueryData(queryKeys.threads('bot_a'))).toEqual([replacement]);
    expect(cache.getQueryData(queryKeys.threads('bot_b'))).toEqual([originalB]);
    expect(cache.getQueryState(queryKeys.messages(originalA.id))).toBeUndefined();
    expect(cache.getQueryData(queryKeys.messages(originalB.id))).toEqual(['B transcript']);
    expect(navigateToBot).not.toHaveBeenCalled();
    expect(transport.createThread).not.toHaveBeenCalled();
  });

  it.each([
    '/bots/bot_b/threads/thread_b',
    '/bots/bot_a/threads/another_thread',
    '/bots/bot_a',
    '/settings',
  ])('checks the live route after async cache cancellation: %s', async (nextPath) => {
    const cache = queryClient();
    const cancellation = Promise.withResolvers<void>();
    vi.spyOn(cache, 'cancelQueries').mockReturnValue(cancellation.promise);
    let pathname = '/bots/bot_a/threads/thread_a';
    const navigateToBot = vi.fn<(botId: string) => Promise<void>>().mockResolvedValue(undefined);
    const pending = finishThreadDeletion(cache, {
      botId: 'bot_a', threadId: 'thread_a', threads: [thread('bot_a', 'fresh')],
    }, { getPathname: () => pathname, navigateToBot });

    pathname = nextPath;
    cancellation.resolve();
    await pending;
    expect(navigateToBot).not.toHaveBeenCalled();
    expect(cache.getQueryData(queryKeys.threads('bot_a'))).toEqual([thread('bot_a', 'fresh')]);
  });

  it('finishes a successful DELETE despite GET 500, then recovers through query refresh', async () => {
    const cache = queryClient();
    const original = thread('bot_a', 'thread_a');
    const replacement = thread('bot_a', 'fresh');
    cache.setQueryData(queryKeys.threads('bot_a'), [original]);
    cache.setQueryData(queryKeys.messages(original.id), ['deleted transcript']);
    const retry = Promise.withResolvers<Thread[]>();
    const threads = new QueryObserver(cache, {
      queryKey: queryKeys.threads('bot_a'),
      queryFn: () => retry.promise,
      staleTime: Infinity,
    });
    const unsubscribe = threads.subscribe(() => {});
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    const transport = {
      deleteThread: vi.fn().mockResolvedValue(undefined),
      listThreads: vi.fn().mockRejectedValue(new Error('Request failed (500)')),
      createThread: vi.fn(),
    };
    let pathname = '/bots/bot_a/threads/thread_a';
    const navigateToBot = vi.fn(async (botId: string) => { pathname = `/bots/${botId}`; });
    const observer = new MutationObserver(cache, {
      mutationFn: (operation: DeleteThreadOperation) => deleteBotThread(transport, operation),
      onSuccess: (deleted) => finishThreadDeletion(cache, deleted, {
        getPathname: () => pathname, navigateToBot,
      }),
    });

    const result = await observer.mutate({ botId: 'bot_a', threadId: original.id });

    expect(result).toEqual({ botId: 'bot_a', threadId: original.id, threads: undefined });
    expect(observer.getCurrentResult().status).toBe('success');
    expect(pathname).toBe('/bots/bot_a');
    expect(navigateToBot).toHaveBeenCalledWith('bot_a');
    expect(cache.getQueryState(queryKeys.messages(original.id))).toBeUndefined();
    expect(cache.getQueryData(queryKeys.threads('bot_a'))).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.threads('bot_a') });
    // Navigation did not wait for this still-pending retry.
    retry.resolve([replacement]);
    await vi.waitFor(() => {
      expect(cache.getQueryData(queryKeys.threads('bot_a'))).toEqual([replacement]);
    });
    unsubscribe();
  });

  it('creates an empty replacement only when the operation Bot has no threads', async () => {
    const replacement = thread('bot_a', 'fresh');
    const transport = {
      deleteThread: vi.fn().mockResolvedValue(undefined),
      listThreads: vi.fn().mockResolvedValue([]),
      createThread: vi.fn().mockResolvedValue(replacement),
    };
    await expect(deleteBotThread(transport, { botId: 'bot_a', threadId: 'old' })).resolves.toEqual({
      botId: 'bot_a', threadId: 'old', threads: [replacement],
    });
    expect(transport.createThread).toHaveBeenCalledWith('bot_a');
  });

  it('still finishes deletion when replacement creation fails', async () => {
    const cache = queryClient();
    const transport = {
      deleteThread: vi.fn().mockResolvedValue(undefined),
      listThreads: vi.fn().mockResolvedValue([]),
      createThread: vi.fn().mockRejectedValue(new Error('Unavailable')),
    };
    const deleted = await deleteBotThread(transport, { botId: 'bot_a', threadId: 'old' });
    const navigateToBot = vi.fn<(botId: string) => Promise<void>>().mockResolvedValue(undefined);
    await finishThreadDeletion(cache, deleted, {
      getPathname: () => '/bots/bot_a/threads/old', navigateToBot,
    });
    expect(navigateToBot).toHaveBeenCalledWith('bot_a');
    expect(cache.getQueryData(queryKeys.threads('bot_a'))).toBeUndefined();
  });

  it('does not perform successful cleanup when DELETE itself fails', async () => {
    const cache = queryClient();
    const original = thread('bot_a', 'thread_a');
    cache.setQueryData(queryKeys.threads('bot_a'), [original]);
    cache.setQueryData(queryKeys.messages(original.id), ['keep']);
    const transport = {
      deleteThread: vi.fn().mockRejectedValue(new Error('DELETE refused')),
      listThreads: vi.fn(),
      createThread: vi.fn(),
    };
    const navigateToBot = vi.fn<(botId: string) => Promise<void>>().mockResolvedValue(undefined);
    const onSuccess = vi.fn((deleted: Awaited<ReturnType<typeof deleteBotThread>>) =>
      finishThreadDeletion(cache, deleted, {
        getPathname: () => '/bots/bot_a/threads/thread_a', navigateToBot,
      }),
    );
    const observer = new MutationObserver(cache, {
      mutationFn: (operation: DeleteThreadOperation) => deleteBotThread(transport, operation),
      onSuccess,
    });
    await expect(observer.mutate({ botId: 'bot_a', threadId: original.id })).rejects.toThrow('DELETE refused');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(transport.listThreads).not.toHaveBeenCalled();
    expect(cache.getQueryData(queryKeys.threads('bot_a'))).toEqual([original]);
    expect(cache.getQueryData(queryKeys.messages(original.id))).toEqual(['keep']);
    expect(navigateToBot).not.toHaveBeenCalled();
  });
});
