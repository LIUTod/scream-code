import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { createGateway } from '../../../src/bot/server/gateway';
import { HttpBotClient } from '../../../src/bot/ui/lib/api/http-client';
import { DraftStore, draftKey, type DraftRequest } from '../../../src/bot/ui/lib/draft';
import { createRuntimeFixture } from '../server/fakes';

it('deduplicates an accepted POST whose ACK is lost, even when newer words were typed', async () => {
  const fixture = createRuntimeFixture();
  const bot = fixture.store.createBot({ name: 'Reader', workspace: process.cwd() });
  const thread = fixture.store.createThread(bot.id);
  const gateway = createGateway({ store: fixture.store, runtime: fixture.runtime, hub: fixture.hub });
  const accepted = Promise.withResolvers<{ runId: string }>();
  const lostResponse = Promise.withResolvers<Response>();
  let first = true;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await gateway.request(new Request(input, init));
    if (first) {
      first = false;
      expect(response.ok).toBe(true);
      accepted.resolve(await response.clone().json() as { runId: string });
      return lostResponse.promise;
    }
    return response;
  });
  vi.stubGlobal('fetch', fetcher);
  const cache = new QueryClient();
  const transport = new HttpBotClient('http://bot.test');
  const drafts = new DraftStore(() => undefined);
  const key = draftKey(bot.id, thread.id);
  const observer = new MutationObserver(cache, {
    retry: false,
    mutationFn: (request: DraftRequest) => transport.prompt(request.threadId, { text: request.text, mode: request.mode, requestKey: request.id }),
    onSuccess: (_result, request) => { drafts.finish(request); },
    onError: (error, request) => { drafts.finish(request, error.message); },
  });
  try {
    drafts.edit(key, 'first task');
    const original = drafts.begin(bot.id, thread.id, 'first task', false)!;
    const sending = observer.mutate(original);
    const firstResult = await accepted.promise;
    expect(fixture.store.listRunsForThread(thread.id)).toHaveLength(1);
    drafts.edit(key, 'second task, still a draft');
    lostResponse.reject(new Error('connection lost after acceptance'));
    await expect(sending).rejects.toThrow('connection lost');
    expect(drafts.get(key).value).toBe('second task, still a draft');
    expect(drafts.get(key).retry?.text).toBe('first task');
    expect(drafts.begin(bot.id, thread.id, drafts.get(key).value, false)).toBeNull();

    const retry = drafts.retry(bot.id, thread.id, false)!;
    expect(retry.id).toBe(original.id);
    expect(retry.text).toBe(original.text);
    const result = await observer.mutate(retry);
    expect(result.runId).toBe(firstResult.runId);
    expect(fixture.store.listRunsForThread(thread.id)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(drafts.get(key)).toMatchObject({ value: 'second task, still a draft', retry: null, pending: null });
    await vi.waitFor(() => { expect(fixture.factory.sessionFor(thread.id).prompts).toEqual(['first task']); });
  } finally {
    cache.clear();
    vi.unstubAllGlobals();
    await fixture.runtime.close();
    fixture.store.close();
  }
});
