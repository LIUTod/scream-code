/**
 * abortRace must detach its abort listener in EVERY outcome. The old
 * abortPromise attached a { once } listener to the caller's signal; when the
 * SDK call won the race (normal completion), the listener stayed attached
 * and the leaked promise rejected LATER when the signal eventually fired —
 * unhandled rejections and one leaked listener per request on long-lived
 * (session-scoped) signals.
 */
import { GoogleGenAIChatProvider } from '#/providers/google-genai';
import { describe, expect, it, vi } from 'vitest';

function createProvider(stream: boolean): GoogleGenAIChatProvider {
  return new GoogleGenAIChatProvider({ model: 'gemini-2.5-flash', apiKey: 'test-key', stream });
}

const okResponse = {
  candidates: [
    { content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  modelVersion: 'test',
};

describe('google-genai abort race listener hygiene', () => {
  it('leaves no leaked listener after a normal completion', async () => {
    const provider = createProvider(false);
    ((provider as never as { _client: { models: Record<string, unknown> } })._client.models)['generateContent'] =
      vi.fn(async () => okResponse);

    const controller = new AbortController();
    const stream = await provider.generate('sys', [], [], { signal: controller.signal });
    for await (const _part of stream) void _part;

    // With the old implementation, abording now would reject the leaked
    // abortPromise(s) that nobody awaits => unhandledRejection fires.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toHaveLength(0);
  });

  it('still aborts a pending generation', async () => {
    const provider = createProvider(false);
    ((provider as never as { _client: { models: Record<string, unknown> } })._client.models)['generateContent'] =
      vi.fn(() => new Promise(() => {}));

    const controller = new AbortController();
    const pending = (async () => {
      const stream = await provider.generate('sys', [], [], { signal: controller.signal });
      for await (const _part of stream) void _part;
    })();

    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeDefined();
  });

  it('already-aborted signal short-circuits before any request', async () => {
    const provider = createProvider(false);
    const generateContent = vi.fn(async () => okResponse);
    ((provider as never as { _client: { models: Record<string, unknown> } })._client.models)['generateContent'] =
      generateContent;

    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.generate('sys', [], [], { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(generateContent).not.toHaveBeenCalled();
  });
});
