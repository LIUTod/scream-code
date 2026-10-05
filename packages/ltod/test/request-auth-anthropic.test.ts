import type { Message } from '#/message';
import type { ProviderRequestAuth } from '#/provider';
import { AnthropicChatProvider } from '#/providers/anthropic';
import type { Tool } from '#/tool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Request-scoped auth shaping for the Anthropic adapter.
 *
 * The SDK is replaced with a capturing mock so the constructor options and the
 * per-request options can be asserted without any network access.
 */
const state = vi.hoisted(() => ({
  ctorOptions: [] as Record<string, unknown>[],
  lastRequestOptions: undefined as Record<string, unknown> | undefined,
  lastParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  const response = {
    id: 'msg_auth_test',
    type: 'message',
    role: 'assistant',
    model: 'k25',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  class CapturingAnthropic {
    readonly messages: { create: (params: unknown, options?: unknown) => Promise<unknown> };
    constructor(options: Record<string, unknown>) {
      state.ctorOptions.push(options);
      this.messages = {
        create: (params: unknown, options?: unknown) => {
          state.lastParams = params as Record<string, unknown> | undefined;
          state.lastRequestOptions = options as Record<string, unknown> | undefined;
          return Promise.resolve(response);
        },
      };
    }
  }
  return { ...actual, default: CapturingAnthropic as unknown as typeof actual.default };
});

function makeHistory(): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] }];
}

async function runGenerate(
  provider: AnthropicChatProvider,
  auth: ProviderRequestAuth,
  request?: { systemPrompt?: string | string[]; tools?: Tool[]; history?: Message[] },
): Promise<void> {
  const stream = await provider.generate(
    request?.systemPrompt ?? 'system',
    request?.tools ?? [],
    request?.history ?? makeHistory(),
    { auth },
  );
  for await (const part of stream) {
    void part;
  }
}

const READ_TOOL: Tool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

/** Every cache_control breakpoint carried by a captured request body. */
function cacheBreakpointCount(params: Record<string, unknown>): number {
  const blocks: unknown[] = [];
  if (Array.isArray(params['system'])) blocks.push(...params['system']);
  if (Array.isArray(params['tools'])) blocks.push(...params['tools']);
  if (Array.isArray(params['messages'])) {
    for (const message of params['messages']) {
      if (message === null || typeof message !== 'object') continue;
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) blocks.push(...content);
    }
  }
  return blocks.filter(
    (block) => block !== null && typeof block === 'object' && 'cache_control' in block,
  ).length;
}

const IDENTITY_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

describe('AnthropicChatProvider request-scoped auth', () => {
  beforeEach(() => {
    state.ctorOptions.length = 0;
    state.lastRequestOptions = undefined;
    state.lastParams = undefined;
    // Isolate from a developer-machine key so the auth path is what builds the client.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses authToken mode when auth headers carry a Bearer token', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', stream: false });

    await runGenerate(provider, { headers: { Authorization: 'Bearer oauth-access-token' } });

    expect(state.ctorOptions).toHaveLength(1);
    const clientOptions = state.ctorOptions.at(-1);
    expect(clientOptions?.['authToken']).toBe('oauth-access-token');
    expect(clientOptions?.['apiKey']).toBeUndefined();
    // The bearer header is also forwarded on the request itself.
    expect(state.lastRequestOptions?.['headers']).toMatchObject({
      Authorization: 'Bearer oauth-access-token',
    });
  });

  it('uses authToken mode when the request key carries the OAuth access-token prefix', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', stream: false });

    await runGenerate(provider, { apiKey: 'sk-ant-oat01-xxx' });

    expect(state.ctorOptions).toHaveLength(1);
    const clientOptions = state.ctorOptions.at(-1);
    expect(clientOptions?.['authToken']).toBe('sk-ant-oat01-xxx');
    expect(clientOptions?.['apiKey']).toBeUndefined();
  });

  it('keeps API-key mode for a regular key', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', stream: false });

    await runGenerate(provider, { apiKey: 'sk-ant-api03-xxx' });

    expect(state.ctorOptions).toHaveLength(1);
    const clientOptions = state.ctorOptions.at(-1);
    expect(clientOptions?.['apiKey']).toBe('sk-ant-api03-xxx');
    expect(clientOptions?.['authToken']).toBeUndefined();
  });

  function requestHeaders(): Record<string, string> {
    return state.lastRequestOptions?.['headers'] as Record<string, string>;
  }

  function betas(): string[] {
    return (requestHeaders()['anthropic-beta'] ?? '').split(',').filter((beta) => beta.length > 0);
  }

  it('adds the subscription betas and client identity for an OAuth bearer token', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', stream: false });

    await runGenerate(provider, { headers: { Authorization: 'Bearer sk-ant-oat01-xxx' } });

    expect(state.ctorOptions.at(-1)?.['defaultHeaders']).toMatchObject({
      'user-agent': expect.stringMatching(/^claude-cli\//) as unknown as string,
      'x-app': 'cli',
    });
    expect(betas()).toEqual(
      expect.arrayContaining([
        'claude-code-20250219',
        'oauth-2025-04-20',
        'interleaved-thinking-2025-05-14',
      ]),
    );
  });

  it('adds the subscription betas for a request-scoped OAuth key', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', stream: false });

    await runGenerate(provider, { apiKey: 'sk-ant-oat01-xxx' });

    expect(state.ctorOptions.at(-1)?.['authToken']).toBe('sk-ant-oat01-xxx');
    expect(state.ctorOptions.at(-1)?.['defaultHeaders']).toMatchObject({ 'x-app': 'cli' });
    expect(betas()).toContain('oauth-2025-04-20');
  });

  it('does not apply the subscription shape to a bearer token from another provider', async () => {
    const provider = new AnthropicChatProvider({ model: 'k25', stream: false });

    await runGenerate(provider, { headers: { Authorization: 'Bearer third-party-token' } });

    expect(state.ctorOptions.at(-1)?.['authToken']).toBe('third-party-token');
    expect(state.ctorOptions.at(-1)?.['defaultHeaders']).toBeUndefined();
    // Only the adapter's own default beta stays; the OAuth betas are opt-in.
    expect(betas()).toEqual(['interleaved-thinking-2025-05-14']);
  });

  function systemBlocks(): { text: string; cache_control?: unknown }[] {
    return (state.lastParams?.['system'] ?? []) as { text: string; cache_control?: unknown }[];
  }

  it('opens the system prompt with the Claude Code identity block for a subscription token', async () => {
    const provider = new AnthropicChatProvider({ model: 'claude-sonnet-4-6', stream: false });

    await runGenerate(
      provider,
      { apiKey: 'sk-ant-oat01-xxx' },
      { systemPrompt: ['static block', 'dynamic block'] },
    );

    expect(state.lastParams?.['system']).toEqual([
      { type: 'text', text: IDENTITY_BLOCK },
      { type: 'text', text: 'static block', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic block' },
    ]);
  });

  it('leaves a plain API-key request without the identity block', async () => {
    const provider = new AnthropicChatProvider({ model: 'claude-sonnet-4-6', stream: false });

    await runGenerate(provider, { apiKey: 'sk-ant-api03-xxx' }, { systemPrompt: ['static block'] });

    expect(state.lastParams?.['system']).toEqual([
      { type: 'text', text: 'static block', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('keeps the identity block outside the cache breakpoint budget', async () => {
    const provider = new AnthropicChatProvider({ model: 'claude-sonnet-4-6', stream: false });

    await runGenerate(provider, { apiKey: 'sk-ant-oat01-xxx' }, {
      tools: [READ_TOOL],
      history: [
        { role: 'user', content: [{ type: 'text', text: 'one' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'two' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'three' }], toolCalls: [] },
      ],
    });

    // System, last tool, penultimate message, last message — unchanged by the
    // extra identity block, which is cached as part of the prefix instead.
    expect(cacheBreakpointCount(state.lastParams ?? {})).toBe(4);
    const system = systemBlocks();
    expect(system[0]?.text).toBe(IDENTITY_BLOCK);
    expect(system[0]?.cache_control).toBeUndefined();
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits the identity block for the exempt 3.5 Haiku family only', async () => {
    for (const model of ['claude-3-5-haiku-20241022', 'claude-haiku-3-5']) {
      const provider = new AnthropicChatProvider({ model, stream: false });
      await runGenerate(provider, { apiKey: 'sk-ant-oat01-xxx' }, { systemPrompt: 'be terse' });
      expect(state.lastParams?.['system']).toEqual([
        { type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } },
      ]);
    }

    const newer = new AnthropicChatProvider({ model: 'claude-haiku-4-5-20251001', stream: false });
    await runGenerate(newer, { apiKey: 'sk-ant-oat01-xxx' }, { systemPrompt: 'be terse' });
    expect(systemBlocks()[0]?.text).toBe(IDENTITY_BLOCK);
  });
});
