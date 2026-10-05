import type { Message } from '#/message';
import type { StreamedMessage } from '#/provider';
import { OpenAILegacyChatProvider } from '#/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '#/providers/openai-responses';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Request-scoped base URL and header-only auth for the OpenAI adapters.
 *
 * The SDK is replaced with a capturing mock so the constructor options can be
 * asserted without any network access.
 */
const state = vi.hoisted(() => ({
  ctorOptions: [] as Record<string, unknown>[],
  chatCompletionsCreate: undefined as
    | ((params: unknown, options?: unknown) => unknown)
    | undefined,
  responsesCreate: undefined as ((params: unknown, options?: unknown) => unknown) | undefined,
}));

vi.mock('openai', () => {
  class CapturingOpenAI {
    readonly chat: { completions: { create: (params: unknown, options?: unknown) => unknown } };
    readonly responses: { create: (params: unknown, options?: unknown) => unknown };

    constructor(options: Record<string, unknown>) {
      state.ctorOptions.push(options);
      this.chat = {
        completions: {
          create: (params: unknown, options?: unknown) => {
            if (state.chatCompletionsCreate === undefined) {
              throw new Error('chat.completions.create was not stubbed by the test');
            }
            return state.chatCompletionsCreate(params, options);
          },
        },
      };
      this.responses = {
        create: (params: unknown, options?: unknown) => {
          if (state.responsesCreate === undefined) {
            throw new Error('responses.create was not stubbed by the test');
          }
          return state.responsesCreate(params, options);
        },
      };
    }
  }
  return { default: CapturingOpenAI };
});

function makeChatCompletionResponse() {
  return {
    id: 'chatcmpl-auth-test',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-4.1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeResponsesAPIResponse() {
  return {
    id: 'resp_auth_test',
    object: 'response',
    created_at: 1234567890,
    status: 'completed',
    model: 'gpt-4.1',
    output: [
      {
        type: 'message',
        id: 'msg_auth_test',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function makeHistory(): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] }];
}

async function drain(stream: StreamedMessage): Promise<void> {
  for await (const part of stream) {
    void part;
  }
}

describe('OpenAI request-scoped auth', () => {
  beforeEach(() => {
    state.ctorOptions.length = 0;
    state.chatCompletionsCreate = undefined;
    state.responsesCreate = undefined;
    // Isolate from a developer-machine key so the auth path is what builds the client.
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('openai-legacy applies auth.baseUrl as the client baseURL', async () => {
    state.chatCompletionsCreate = () => Promise.resolve(makeChatCompletionResponse());
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'constructor-key',
      baseUrl: 'https://default.test/v1',
      stream: false,
    });

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { baseUrl: 'https://override.test/v1' },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(2);
    expect(state.ctorOptions.at(-1)?.['baseURL']).toBe('https://override.test/v1');
  });

  it('openai-legacy keeps the configured baseURL when auth has none', async () => {
    state.chatCompletionsCreate = () => Promise.resolve(makeChatCompletionResponse());
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'constructor-key',
      baseUrl: 'https://default.test/v1',
      stream: false,
    });

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { apiKey: 'request-key' },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(2);
    expect(state.ctorOptions.at(-1)?.['baseURL']).toBe('https://default.test/v1');
  });

  it('openai-legacy accepts header-only auth when no key is configured', async () => {
    state.chatCompletionsCreate = () => Promise.resolve(makeChatCompletionResponse());
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      baseUrl: 'https://default.test/v1',
      stream: false,
    });

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { headers: { Authorization: 'Bearer oauth-token' } },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(1);
    const clientOptions = state.ctorOptions.at(-1);
    expect(clientOptions?.['apiKey']).toBe('oauth-bearer');
    expect(clientOptions?.['defaultHeaders']).toMatchObject({
      Authorization: 'Bearer oauth-token',
    });
  });

  it('openai-legacy prefers the request key over the constructor key', async () => {
    state.chatCompletionsCreate = () => Promise.resolve(makeChatCompletionResponse());
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'constructor-key',
      baseUrl: 'https://default.test/v1',
      stream: false,
    });

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { apiKey: 'request-key', headers: { Authorization: 'Bearer oauth-token' } },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(2);
    const clientOptions = state.ctorOptions.at(-1);
    expect(clientOptions?.['apiKey']).toBe('request-key');
    expect(clientOptions?.['defaultHeaders']).toMatchObject({
      Authorization: 'Bearer oauth-token',
    });
  });

  it('openai-responses applies auth.baseUrl as the client baseURL', async () => {
    state.responsesCreate = () => Promise.resolve(makeResponsesAPIResponse());
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-4.1',
      apiKey: 'constructor-key',
      baseUrl: 'https://default.test/v1',
    });
    Reflect.set(provider, '_stream', false);

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { baseUrl: 'https://override.test/v1' },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(2);
    expect(state.ctorOptions.at(-1)?.['baseURL']).toBe('https://override.test/v1');
  });

  it('openai-responses keeps the configured baseURL when auth has none', async () => {
    state.responsesCreate = () => Promise.resolve(makeResponsesAPIResponse());
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-4.1',
      apiKey: 'constructor-key',
      baseUrl: 'https://default.test/v1',
    });
    Reflect.set(provider, '_stream', false);

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { apiKey: 'request-key' },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(2);
    expect(state.ctorOptions.at(-1)?.['baseURL']).toBe('https://default.test/v1');
  });

  it('openai-responses accepts header-only auth when no key is configured', async () => {
    state.responsesCreate = () => Promise.resolve(makeResponsesAPIResponse());
    const provider = new OpenAIResponsesChatProvider({
      model: 'gpt-4.1',
      baseUrl: 'https://default.test/v1',
    });
    Reflect.set(provider, '_stream', false);

    const stream = await provider.generate('', [], makeHistory(), {
      auth: { headers: { Authorization: 'Bearer oauth-token' } },
    });
    await drain(stream);

    expect(state.ctorOptions).toHaveLength(1);
    const clientOptions = state.ctorOptions.at(-1);
    expect(clientOptions?.['apiKey']).toBe('oauth-bearer');
    expect(clientOptions?.['defaultHeaders']).toMatchObject({
      Authorization: 'Bearer oauth-token',
    });
  });
});
