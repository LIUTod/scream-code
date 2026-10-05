/**
 * OpenAI Codex (ChatGPT subscription) wire tests: endpoint resolution, header
 * set, request-body sanitization, structured-credential parsing, SSE folding
 * and error mapping. Every network round-trip is stubbed with an injected
 * fetch; no request leaves the machine.
 */

import {
  APIConnectionError,
  APIProviderRateLimitError,
  APIStatusError,
  ChatProviderError,
  isRetryableGenerateError,
} from '#/errors';
import type { Message, StreamedMessagePart, ToolCall } from '#/message';
import type { StreamedMessage } from '#/provider';
import {
  CODEX_DEFAULT_BASE_URL,
  OpenAICodexChatProvider,
  buildCodexHeaders,
  buildCodexRequestBody,
  parseOpenAICodexCredentials,
  resolveCodexEndpoint,
  sanitizeCodexRequestBody,
  type OpenAICodexFetch,
} from '#/providers/openai-codex';
import { createProvider } from '#/providers/index';
import type { Tool } from '#/tool';
import { describe, expect, it } from 'vitest';

const RESPONSES_PATH = '/codex/responses';
const DEFAULT_ENDPOINT = `${CODEX_DEFAULT_BASE_URL}${RESPONSES_PATH}`;

function structuredCredentials(token = 'access-token', accountId = 'acct-123'): string {
  return JSON.stringify({ token, accountId });
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(chunks: string[], status = 200, headers?: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });
}

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function capturingFetch(
  handler: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): { fetchImpl: OpenAICodexFetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl: OpenAICodexFetch = async (url, init) => {
    const request: CapturedRequest = {
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  return { fetchImpl, requests };
}

async function collect(stream: StreamedMessage): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

function makeProvider(options: {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  sessionId?: string;
  fetchImpl: OpenAICodexFetch;
}): OpenAICodexChatProvider {
  return new OpenAICodexChatProvider({
    model: options.model ?? 'gpt-5-codex',
    apiKey: options.apiKey ?? structuredCredentials(),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    fetch: options.fetchImpl,
  });
}

/** Minimal unsigned JWT whose payload carries the given claims. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

const READ_TOOL: Tool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const TEXT_STREAM: string[] = [
  sseEvent({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5-codex' } }),
  sseEvent({ type: 'response.output_text.delta', delta: 'Hel' }),
  sseEvent({ type: 'response.output_text.delta', delta: 'lo' }),
  sseEvent({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-5-codex',
      status: 'completed',
      usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
    },
  }),
  'data: [DONE]\n\n',
];

describe('Codex endpoint resolution', () => {
  it('appends the streaming path to the default backend root', () => {
    expect(resolveCodexEndpoint(undefined)).toBe(DEFAULT_ENDPOINT);
    expect(resolveCodexEndpoint('')).toBe(DEFAULT_ENDPOINT);
  });

  it('normalizes trailing slashes and pre-completed paths', () => {
    expect(resolveCodexEndpoint('https://chatgpt.com/backend-api/')).toBe(DEFAULT_ENDPOINT);
    expect(resolveCodexEndpoint('https://chatgpt.com/backend-api/codex')).toBe(DEFAULT_ENDPOINT);
    expect(resolveCodexEndpoint(DEFAULT_ENDPOINT)).toBe(DEFAULT_ENDPOINT);
  });

  it('honors a gateway root', () => {
    expect(resolveCodexEndpoint('https://gateway.example/backend-api')).toBe(
      `https://gateway.example/backend-api${RESPONSES_PATH}`,
    );
  });
});

describe('Codex request shape', () => {
  it('posts the sanitized body to the codex path with the subscription headers', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl, sessionId: 'sess-1' });

    await collect(await provider.generate('be terse', [READ_TOOL], [userMessage('hi')]));

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(DEFAULT_ENDPOINT);

    expect(request.headers.get('authorization')).toBe('Bearer access-token');
    expect(request.headers.get('chatgpt-account-id')).toBe('acct-123');
    expect(request.headers.get('originator')).toBe('scream-code');
    expect(request.headers.get('version')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(request.headers.get('session_id')).toBe('sess-1');
    expect(request.headers.get('conversation_id')).toBe('sess-1');
    expect(request.headers.get('x-client-request-id')).toBe('sess-1');
    expect(request.headers.get('openai-beta')).toBe('responses=experimental');
    expect(request.headers.get('accept')).toBe('text/event-stream');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('x-codex-routing-hint')).toBe('model=gpt-5-codex');
    // The user agent names this client and the runtime it runs on.
    expect(request.headers.get('user-agent')).toMatch(/^scream-code \(.+; .+\)$/);

    const body = request.body;
    expect(body['model']).toBe('gpt-5-codex');
    expect(body['instructions']).toBe('be terse');
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body['tool_choice']).toBe('auto');
    expect(body['parallel_tool_calls']).toBe(true);
    expect(body['prompt_cache_key']).toBe('sess-1');
    expect(body['max_output_tokens']).toBeUndefined();

    // The system prompt rides on `instructions`; the input carries only history.
    const input = body['input'] as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    });

    expect(body['tools']).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: READ_TOOL.parameters,
        strict: false,
      },
    ]);
  });

  it('omits tool parameters from a request that declares no tools', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl });

    await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    const body = requests[0]!.body;
    expect(body['tools']).toBeUndefined();
    expect(body['tool_choice']).toBeUndefined();
    expect(body['parallel_tool_calls']).toBeUndefined();
  });

  it('uses the request base URL when no backend root is configured', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl });

    await collect(
      await provider.generate('', [], [userMessage('hi')], {
        auth: { apiKey: structuredCredentials(), baseUrl: 'https://gateway.example/backend-api' },
      }),
    );

    expect(requests[0]!.url).toBe(`https://gateway.example/backend-api${RESPONSES_PATH}`);
  });

  it('keeps the configured backend root when the request auth carries one too', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl, baseUrl: 'https://mirror.example/backend-api' });

    await collect(
      await provider.generate('', [], [userMessage('hi')], {
        auth: { apiKey: structuredCredentials(), baseUrl: DEFAULT_ENDPOINT },
      }),
    );

    // The sign-in reports its own default endpoint through the request auth;
    // a configured proxy/mirror must not be shadowed by it.
    expect(requests[0]!.url).toBe(`https://mirror.example/backend-api${RESPONSES_PATH}`);
  });

  it('falls back to a neutral instruction when no system prompt is given', () => {
    const body = buildCodexRequestBody({
      model: 'gpt-5-codex',
      systemPrompt: [],
      tools: [],
      history: [userMessage('hi')],
      sessionId: 'sess-1',
    });
    expect(typeof body['instructions']).toBe('string');
    expect((body['instructions'] as string).length).toBeGreaterThan(0);
    expect(body['tools']).toBeUndefined();
  });

  it('maps thinking effort onto the reasoning field', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl }).withThinking('high');

    expect(provider.thinkingEffort).toBe('high');
    await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    expect(requests[0]!.body['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('omits the reasoning field when thinking is off', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl }).withThinking('off');

    await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    expect(requests[0]!.body['reasoning']).toBeUndefined();
  });
});

describe('Codex body sanitization', () => {
  it('drops sampling controls and caller-supplied output caps', () => {
    const body = sanitizeCodexRequestBody({
      model: 'gpt-5-codex',
      store: true,
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      presence_penalty: 1,
      frequency_penalty: 1,
      repetition_penalty: 1,
      stop: ['\n'],
      logprobs: true,
      top_logprobs: 5,
      logit_bias: { '1': 1 },
      seed: 42,
      n: 2,
      max_output_tokens: 4096,
      max_completion_tokens: 2048,
    });

    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    // No tools declared, so neither tool parameter goes out: the backend
    // rejects them as unsupported on a tool-free request.
    expect(body['tool_choice']).toBeUndefined();
    expect(body['parallel_tool_calls']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
    for (const field of [
      'temperature',
      'top_p',
      'top_k',
      'min_p',
      'presence_penalty',
      'frequency_penalty',
      'repetition_penalty',
      'stop',
      'logprobs',
      'top_logprobs',
      'logit_bias',
      'seed',
      'n',
      'max_output_tokens',
      'max_completion_tokens',
    ]) {
      expect(body[field]).toBeUndefined();
    }
  });

  it('keeps existing includes, and forces automatic tool choice for object choices', () => {
    const body = sanitizeCodexRequestBody({
      include: ['other.include', 'reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'read_file' }],
      tool_choice: { type: 'function', name: 'read_file' },
    });

    expect(body['include']).toEqual(['other.include', 'reasoning.encrypted_content']);
    expect(body['tool_choice']).toBe('auto');
  });

  it('preserves the explicit none/required string tool choices', () => {
    const tools = [{ type: 'function', name: 'read_file' }];
    expect(sanitizeCodexRequestBody({ tools, tool_choice: 'none' })['tool_choice']).toBe('none');
    expect(sanitizeCodexRequestBody({ tools, tool_choice: 'required' })['tool_choice']).toBe(
      'required',
    );
  });
});

describe('Codex headers', () => {
  it('declares the workspace residency carried by the token', () => {
    const token = fakeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-1',
        chatgpt_data_residency: 'eu',
      },
    });

    const headers = buildCodexHeaders({
      token,
      accountId: 'acct-1',
      model: 'gpt-5-codex',
      sessionId: 'sess-1',
    });

    expect(headers['x-openai-internal-codex-residency']).toBe('eu');
  });

  it('leaves the residency header off for tokens without the claim', () => {
    const headers = buildCodexHeaders({
      token: 'opaque-token',
      accountId: 'acct-1',
      model: 'gpt-5-codex',
      sessionId: 'sess-1',
    });

    expect(headers['x-openai-internal-codex-residency']).toBeUndefined();
  });

  it('honors the client version override', () => {
    const previous = process.env['SCREAM_CODE_CODEX_CLIENT_VERSION'];
    process.env['SCREAM_CODE_CODEX_CLIENT_VERSION'] = '9.9.9';
    try {
      const headers = buildCodexHeaders({
        token: 'access-token',
        accountId: 'acct-1',
        model: 'gpt-5-codex',
        sessionId: 'sess-1',
      });
      expect(headers['version']).toBe('9.9.9');
    } finally {
      if (previous === undefined) delete process.env['SCREAM_CODE_CODEX_CLIENT_VERSION'];
      else process.env['SCREAM_CODE_CODEX_CLIENT_VERSION'] = previous;
    }
  });
});

describe('Codex credentials', () => {
  it('parses the structured credential', () => {
    expect(parseOpenAICodexCredentials(structuredCredentials())).toEqual({
      token: 'access-token',
      accountId: 'acct-123',
    });
  });

  it('accepts the documented aliases', () => {
    expect(
      parseOpenAICodexCredentials(JSON.stringify({ access_token: 't', account_id: 'a' })),
    ).toEqual({ token: 't', accountId: 'a' });
    expect(parseOpenAICodexCredentials(JSON.stringify({ access: 't', accountId: 'a' }))).toEqual({
      token: 't',
      accountId: 'a',
    });
  });

  it('rejects values that are not a structured credential', () => {
    expect(() => parseOpenAICodexCredentials('sk-plain-api-key')).toThrow(ChatProviderError);
    expect(() => parseOpenAICodexCredentials('sk-plain-api-key')).toThrow(/\/login/);
    expect(() => parseOpenAICodexCredentials('["token"]')).toThrow(/\/login/);
  });

  it('rejects a credential without a token or without an account id', () => {
    expect(() => parseOpenAICodexCredentials(JSON.stringify({ accountId: 'a' }))).toThrow(
      /missing token or accountId/,
    );
    expect(() => parseOpenAICodexCredentials(JSON.stringify({ token: 't' }))).toThrow(
      /missing token or accountId/,
    );
    expect(() => parseOpenAICodexCredentials(JSON.stringify({ token: '', accountId: 'a' }))).toThrow(
      /\/login/,
    );
  });

  it('fails before any request when the configured credential is not structured', async () => {
    let called = false;
    const provider = makeProvider({
      apiKey: 'sk-plain-api-key',
      fetchImpl: async () => {
        called = true;
        return sseResponse(TEXT_STREAM);
      },
    });

    await expect(provider.generate('', [], [userMessage('hi')])).rejects.toThrow(/\/login/);
    expect(called).toBe(false);
  });
});

describe('Codex SSE folding', () => {
  it('folds text deltas and reports id, usage and finish reason', async () => {
    const { fetchImpl } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl });

    const stream = await provider.generate('be terse', [], [userMessage('hi')]);
    const parts = await collect(stream);

    expect(parts).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(stream.id).toBe('resp_1');
    expect(stream.model).toBe('gpt-5-codex');
    expect(stream.usage).toEqual({
      inputOther: 8,
      output: 3,
      inputCacheRead: 4,
      inputCacheCreation: 0,
    });
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('completed');
  });

  it('folds tool calls from the streaming deltas', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file' },
        }),
        sseEvent({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          output_index: 0,
          delta: '{"path":',
        }),
        sseEvent({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          output_index: 0,
          delta: '"a.ts"}',
        }),
        sseEvent({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a.ts"}',
          },
        }),
        sseEvent({ type: 'response.completed', response: { id: 'resp_2', status: 'completed' } }),
      ]),
    );
    const provider = makeProvider({ fetchImpl });

    const parts = await collect(await provider.generate('be terse', [READ_TOOL], [userMessage('hi')]));

    const toolCall = parts.find((part): part is ToolCall => part.type === 'function');
    expect(toolCall).toMatchObject({ id: 'call_1', name: 'read_file' });
    const argumentDeltas = parts
      .filter((part) => part.type === 'tool_call_part')
      .map((part) => (part as { argumentsPart: string }).argumentsPart)
      .join('');
    expect(argumentDeltas).toBe('{"path":"a.ts"}');
  });

  it('replays the encrypted reasoning payload as a think part', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', encrypted_content: 'enc_1', summary: [] },
        }),
        sseEvent({ type: 'response.completed', response: { id: 'resp_3', status: 'completed' } }),
      ]),
    );
    const provider = makeProvider({ fetchImpl });

    const parts = await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    expect(parts).toEqual([{ type: 'think', think: '', encrypted: 'enc_1' }]);
  });

  it('parses both events when a chunk boundary splits a CRLF line ending', async () => {
    const raw =
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\r\n\r\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_5', status: 'completed' } })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(raw);
    // Cut between the `\r` and the `\n` that close the first event: normalizing
    // each chunk on its own leaves a stray `\r\n` behind and folds both events
    // into one payload.
    const split = raw.indexOf('\r\n\r\n') + 3;
    expect(raw.slice(split - 1, split + 1)).toBe('\r\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const { fetchImpl } = capturingFetch(() => new Response(stream, { status: 200 }));
    const provider = makeProvider({ fetchImpl });

    const streamed = await provider.generate('be terse', [], [userMessage('hi')]);
    const parts = await collect(streamed);

    expect(parts).toEqual([{ type: 'text', text: 'ok' }]);
    // The second event was parsed as well, not merged into the first.
    expect(streamed.id).toBe('resp_5');
  });

  it('accepts CRLF framed events split across chunks', async () => {
    const raw = `event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"ok"}\r\n\r\ndata: {"type":"response.completed","response":{"id":"resp_4","status":"completed"}}\r\n\r\n`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(raw);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-event to exercise the buffer reassembly.
        controller.enqueue(bytes.slice(0, 40));
        controller.enqueue(bytes.slice(40));
        controller.close();
      },
    });
    const { fetchImpl } = capturingFetch(() => new Response(stream, { status: 200 }));
    const provider = makeProvider({ fetchImpl });

    const parts = await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    expect(parts).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('Codex error mapping', () => {
  it('maps a rate-limited response onto the provider rate-limit error', async () => {
    const { fetchImpl } = capturingFetch(() =>
      new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    );
    const provider = makeProvider({ fetchImpl });

    const error = await collect(await provider.generate('', [], [userMessage('hi')])).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect((error as APIStatusError).statusCode).toBe(429);
    expect((error as APIStatusError).message).toContain('OpenAI Codex API error (429)');
    expect((error as APIProviderRateLimitError).retryAfterMs).toBe(30_000);
  });

  it('maps an unauthorized response onto a status error carrying the body', async () => {
    const { fetchImpl } = capturingFetch(() =>
      new Response('token expired', { status: 401 }),
    );
    const provider = makeProvider({ fetchImpl });

    const error = await collect(await provider.generate('', [], [userMessage('hi')])).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(401);
    expect((error as APIStatusError).message).toContain('token expired');
  });

  it('reports a stream that ends before a terminal completion event', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({ type: 'response.created', response: { id: 'resp_6', model: 'gpt-5-codex' } }),
        sseEvent({ type: 'response.output_text.delta', delta: 'Hel' }),
      ]),
    );
    const provider = makeProvider({ fetchImpl });

    const stream = await provider.generate('be terse', [], [userMessage('hi')]);
    const parts: StreamedMessagePart[] = [];
    const failure = await (async () => {
      for await (const part of stream) parts.push(part);
    })().catch((error: unknown) => error);

    // The half-answer is surfaced as a failure, not consumed as a complete turn.
    expect(parts).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(failure).toBeInstanceOf(APIConnectionError);
    expect((failure as Error).message).toContain('terminal completion event');
    expect(isRetryableGenerateError(failure)).toBe(true);
  });

  it('accepts response.incomplete as a terminal event', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({ type: 'response.output_text.delta', delta: 'Hel' }),
        sseEvent({
          type: 'response.incomplete',
          response: { id: 'resp_7', status: 'incomplete', usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      ]),
    );
    const provider = makeProvider({ fetchImpl });

    const parts = await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    expect(parts).toEqual([{ type: 'text', text: 'Hel' }]);
  });

  it('reports a malformed stream event as a provider error', async () => {
    const { fetchImpl } = capturingFetch(() => sseResponse(['data: {not json}\n\n']));
    const provider = makeProvider({ fetchImpl });

    await expect(
      collect(await provider.generate('', [], [userMessage('hi')])),
    ).rejects.toThrow(/malformed stream event/);
  });

  it('maps a transport failure onto a connection error', async () => {
    const provider = makeProvider({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(
      collect(await provider.generate('', [], [userMessage('hi')])),
    ).rejects.toBeInstanceOf(APIConnectionError);
  });

  it('rejects an already-aborted request without calling fetch', async () => {
    let called = false;
    const provider = makeProvider({
      fetchImpl: async () => {
        called = true;
        return sseResponse(TEXT_STREAM);
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.generate('', [], [userMessage('hi')], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toBe(false);
  });

  it('reports a cancel that lands as the body closes as an abort, not a truncation', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({ type: 'response.created', response: { id: 'resp_8', model: 'gpt-5-codex' } }),
        sseEvent({ type: 'response.output_text.delta', delta: 'Hel' }),
      ]),
    );
    const provider = makeProvider({ fetchImpl });
    const controller = new AbortController();

    const stream = await provider.generate('be terse', [], [userMessage('hi')], {
      signal: controller.signal,
    });
    const parts: StreamedMessagePart[] = [];
    const failure = await (async () => {
      for await (const part of stream) {
        parts.push(part);
        // The cancel lands before the reader pulls the next value, so the body
        // is found closed while the request is already aborted.
        controller.abort();
      }
    })().catch((error: unknown) => error);

    expect(parts).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(failure).not.toBeInstanceOf(APIConnectionError);
  });

  it('reports a stream cancelled mid-flight as an abort', async () => {
    const { fetchImpl } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl });
    const controller = new AbortController();

    const stream = await provider.generate('', [], [userMessage('hi')], {
      signal: controller.signal,
    });
    const parts: StreamedMessagePart[] = [];
    await expect(
      (async () => {
        for await (const part of stream) {
          parts.push(part);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(parts.length).toBeGreaterThan(0);
  });
});

describe('Codex provider wiring', () => {
  it('is constructible through the provider factory', () => {
    const provider = createProvider({
      type: 'openai-codex',
      model: 'gpt-5-codex',
      apiKey: structuredCredentials(),
    });

    expect(provider).toBeInstanceOf(OpenAICodexChatProvider);
    expect(provider.name).toBe('openai-codex');
    expect(provider.modelName).toBe('gpt-5-codex');
  });

  it('reports reasoning and tool capability for Codex models', () => {
    const provider = new OpenAICodexChatProvider({ model: 'gpt-5-codex', apiKey: 'unused' });

    expect(provider.getCapability('gpt-5-codex')).toMatchObject({
      thinking: true,
      tool_use: true,
      image_in: false,
    });
    expect(provider.getCapability('gpt-5.1-codex-mini')).toMatchObject({
      thinking: true,
      tool_use: true,
    });
    expect(provider.getCapability('gpt-4o')).toMatchObject({ image_in: true });
  });

  it('keeps one session id across thinking clones and requests', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));
    const provider = makeProvider({ fetchImpl });
    const thinking = provider.withThinking('medium');

    await collect(await thinking.generate('', [], [userMessage('one')]));
    await collect(await thinking.generate('', [], [userMessage('two')]));

    const first = requests[0]!;
    const second = requests[1]!;
    expect(first.headers.get('session_id')).toBe(second.headers.get('session_id'));
    expect(first.body['prompt_cache_key']).toBe(second.body['prompt_cache_key']);
    expect(first.headers.get('session_id')).not.toBe('');
  });

  it('generates a session id per provider instance when none is configured', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse(TEXT_STREAM));

    await collect(await makeProvider({ fetchImpl }).generate('', [], [userMessage('one')]));
    await collect(await makeProvider({ fetchImpl }).generate('', [], [userMessage('two')]));

    expect(requests[0]!.headers.get('session_id')).not.toBe(
      requests[1]!.headers.get('session_id'),
    );
  });
});
