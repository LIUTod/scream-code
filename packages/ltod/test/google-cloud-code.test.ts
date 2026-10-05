import { APIProviderRateLimitError, APIStatusError, ChatProviderError } from '#/errors';
import {
  mergeInPlace,
  type Message,
  type StreamedMessagePart,
  type ThinkPart,
  type ToolCall,
} from '#/message';
import type { StreamedMessage } from '#/provider';
import { parseRateLimitReason } from '#/rate-limit-utils';
import {
  CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT,
  CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT,
  CLOUD_CODE_ASSIST_DEFAULT_ENDPOINT,
  GoogleCloudCodeChatProvider,
  buildCloudCodeAssistRequest,
  inferGoogleCloudCodeVariant,
  parseGoogleCloudCodeCredentials,
  type GoogleCloudCodeFetch,
} from '#/providers/google-cloud-code';
import { createProvider } from '#/providers/index';
import type { Tool } from '#/tool';
import { describe, expect, it } from 'vitest';

const STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse';

function structuredCredentials(extra?: Record<string, unknown>): string {
  return JSON.stringify({ token: 'access-token', projectId: 'proj-123', ...extra });
}

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** An event framed with CRLF line endings, as the Cloud Code Assist host sends it. */
function crlfEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\r\n\r\n`;
}

function assistantTurn(toolCalls: ToolCall[]): Message {
  return { role: 'assistant', content: [], toolCalls };
}

function functionCall(name: string, id: string, args: Record<string, unknown>): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

/** Every replayed `model` turn of a history, as the request builder produces it. */
function replayedModelParts(
  model: string,
  history: Message[],
  variant: 'gemini-cli' | 'antigravity' = 'gemini-cli',
) {
  const body = buildCloudCodeAssistRequest({
    model,
    projectId: 'proj-123',
    systemPrompt: 'sys',
    tools: [],
    history,
    variant,
    thinking: undefined,
    session: {},
  });
  return body.request.contents
    .filter((content) => content.role === 'model')
    .flatMap((content) => content.parts);
}

/** The single tool declaration the request builder produces for a model. */
function toolDeclaration(
  model: string,
  variant: 'gemini-cli' | 'antigravity',
): Record<string, unknown> | undefined {
  const body = buildCloudCodeAssistRequest({
    model,
    projectId: 'proj-123',
    systemPrompt: 'sys',
    tools: [readTool],
    history: [userMessage('hi')],
    variant,
    thinking: undefined,
    session: {},
  });
  return body.request.tools?.[0]?.functionDeclarations[0];
}

function textResponse(text: string, finishReason = 'STOP'): Response {
  return sseResponse([
    sseEvent({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
      },
    }),
  ]);
}

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function capturingFetch(
  handler: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): { fetchImpl: GoogleCloudCodeFetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl: GoogleCloudCodeFetch = async (url, init) => {
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
  variant?: 'gemini-cli' | 'antigravity';
  fetchImpl: GoogleCloudCodeFetch;
}): GoogleCloudCodeChatProvider {
  return new GoogleCloudCodeChatProvider({
    model: options.model ?? 'gemini-3-flash',
    apiKey: options.apiKey ?? structuredCredentials(),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
    fetch: options.fetchImpl,
  });
}

const readTool: Tool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      selector: { type: 'object', patternProperties: { '^.*$': { type: 'string' } } },
    },
    required: ['path'],
  },
};

describe('Cloud Code Assist request envelope', () => {
  it('posts the bare { project, model, request } envelope to the default host', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    await collect(await provider.generate('be terse', [], [userMessage('implement token refresh')]));

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    // The request body is typed as a JSON object; index into it explicitly.
    const body = request.body as unknown as {
      project: string;
      model: string;
      request: { contents: unknown; systemInstruction?: unknown };
      requestType?: string;
      userAgent?: string;
      requestId?: string;
    };
    expect(request.url).toBe(`${CLOUD_CODE_ASSIST_DEFAULT_ENDPOINT}${STREAM_PATH}`);
    expect(request.headers.get('authorization')).toBe('Bearer access-token');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('accept')).toBe('text/event-stream');
    expect(request.headers.get('user-agent')).toMatch(/^GeminiCLI\/[0-9.]+/);
    expect(request.headers.get('client-metadata')).toBe(
      'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
    );

    expect(body.project).toBe('proj-123');
    expect(body.model).toBe('gemini-3-flash');
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'implement token refresh' }] },
    ]);
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    // Antigravity-only metadata stays off the plain Cloud Code Assist envelope.
    expect(body.requestType).toBeUndefined();
    expect(body.userAgent).toBeUndefined();
    expect(body.requestId).toBeUndefined();
  });

  it('adds the antigravity session envelope and user agent on the daily host', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({
      variant: 'antigravity',
      baseUrl: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT,
      fetchImpl,
    });

    await collect(await provider.generate(['be terse', '', 'stay neutral'], [], [userMessage('hi')]));

    const request = requests[0]!;
    const body = request.body as unknown as {
      request: { sessionId?: string; labels?: Record<string, string>; systemInstruction?: { role?: string } };
      requestType?: string;
      userAgent?: string;
      requestId?: string;
    };
    expect(request.url).toBe(`${CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT}${STREAM_PATH}`);
    expect(request.headers.get('user-agent')).toMatch(/^antigravity\/hub\/[0-9.]+ /);
    expect(request.headers.get('client-metadata')).toBeNull();

    expect(body.requestType).toBe('agent');
    expect(body.userAgent).toBe('antigravity');
    expect(body.requestId).toMatch(/^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/\d+$/);
    expect(body.request.sessionId).toMatch(/^-[0-9]+$/);
    // The native client tags the system instruction with the user role, and
    // drops the empty block while keeping the order.
    expect(body.request.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'be terse' }, { text: 'stay neutral' }],
    });
    const labels = body.request.labels;
    expect(labels?.['trajectory_id']).toMatch(/^[0-9a-f-]+$/);
    expect(labels?.['last_step_index']).toBe('1');
    expect(labels?.['used_claude']).toBe('false');
    expect(labels?.['used_claude_conservative']).toBe('false');
  });

  it('carries a Claude request as a Claude-weighted antigravity turn', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({
      model: 'claude-sonnet-4-6',
      variant: 'antigravity',
      baseUrl: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT,
      fetchImpl,
    });

    await collect(await provider.generate('be terse', [], [userMessage('hi')]));

    const body = requests[0]!.body as unknown as {
      request: { labels?: Record<string, string>; toolConfig?: unknown };
    };
    expect(body.request.labels?.['used_claude']).toBe('true');
    // Claude routes keep the validated tool mode even without declarations.
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } });
  });

  it('announces interleaved thinking only to Claude models behind Antigravity', async () => {
    const daily = CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT;
    const anthropicBeta = 'interleaved-thinking-2025-05-14';

    const antigravity = capturingFetch(() => textResponse('ok'));
    const claudeOnAntigravity = makeProvider({
      model: 'claude-sonnet-4-6',
      variant: 'antigravity',
      baseUrl: daily,
      fetchImpl: antigravity.fetchImpl,
    });
    await collect(await claudeOnAntigravity.generate('sys', [], [userMessage('hi')]));
    expect(antigravity.requests[0]!.headers.get('anthropic-beta')).toBe(anthropicBeta);

    const gemini = capturingFetch(() => textResponse('ok'));
    const geminiOnAntigravity = makeProvider({
      model: 'gemini-3-flash',
      variant: 'antigravity',
      baseUrl: daily,
      fetchImpl: gemini.fetchImpl,
    });
    await collect(await geminiOnAntigravity.generate('sys', [], [userMessage('hi')]));
    expect(gemini.requests[0]!.headers.get('anthropic-beta')).toBeNull();

    const cli = capturingFetch(() => textResponse('ok'));
    const claudeOnCli = makeProvider({
      model: 'claude-sonnet-4-6',
      variant: 'gemini-cli',
      fetchImpl: cli.fetchImpl,
    });
    await collect(await claudeOnCli.generate('sys', [], [userMessage('hi')]));
    expect(cli.requests[0]!.headers.get('anthropic-beta')).toBeNull();
  });

  it('sends tool declarations in the shape each surface expects and strips unsupported schema keywords', async () => {
    const cli = capturingFetch(() => textResponse('ok'));
    const cliProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: cli.fetchImpl });
    await collect(await cliProvider.generate('sys', [readTool], [userMessage('hi')]));

    const cliBody = cli.requests[0]!.body as unknown as {
      request: { tools?: { functionDeclarations: Record<string, unknown>[] }[]; toolConfig?: unknown };
    };
    const cliDeclaration = cliBody.request.tools?.[0]?.functionDeclarations[0];
    expect(cliDeclaration?.['name']).toBe('read_file');
    expect(cliDeclaration?.['parametersJsonSchema']).toBeDefined();
    expect(cliDeclaration?.['parameters']).toBeUndefined();
    expect(JSON.stringify(cliDeclaration?.['parametersJsonSchema'])).not.toContain('patternProperties');
    expect(cliBody.request.toolConfig).toBeUndefined();

    const antigravity = capturingFetch(() => textResponse('ok'));
    const antigravityProvider = makeProvider({
      variant: 'antigravity',
      baseUrl: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT,
      fetchImpl: antigravity.fetchImpl,
    });
    await collect(await antigravityProvider.generate('sys', [readTool], [userMessage('hi')]));

    const antigravityBody = antigravity.requests[0]!.body as unknown as {
      request: { tools?: { functionDeclarations: Record<string, unknown>[] }[]; toolConfig?: unknown };
    };
    const antigravityDeclaration = antigravityBody.request.tools?.[0]?.functionDeclarations[0];
    // The antigravity routes translate the legacy `parameters` field.
    expect(antigravityDeclaration?.['parameters']).toBeDefined();
    expect(antigravityDeclaration?.['parametersJsonSchema']).toBeUndefined();
    expect(JSON.stringify(antigravityDeclaration?.['parameters'])).not.toContain('patternProperties');
    expect(antigravityBody.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    });
  });

  it('selects the tool schema field by surface and model class', () => {
    // Claude models take the legacy field on either host: the backend
    // translates it into their `input_schema`.
    const claudeOnCli = toolDeclaration('claude-sonnet-4-6', 'gemini-cli');
    expect(claudeOnCli?.['parameters']).toBeDefined();
    expect(claudeOnCli?.['parametersJsonSchema']).toBeUndefined();

    const claudeOnAntigravity = toolDeclaration('claude-sonnet-4-6', 'antigravity');
    expect(claudeOnAntigravity?.['parameters']).toBeDefined();
    expect(claudeOnAntigravity?.['parametersJsonSchema']).toBeUndefined();

    // Gemini models keep the full JSON schema on the plain Cloud Code Assist
    // host, and the translated legacy field on Antigravity.
    const geminiOnCli = toolDeclaration('gemini-3.1-pro-preview', 'gemini-cli');
    expect(geminiOnCli?.['parametersJsonSchema']).toBeDefined();
    expect(geminiOnCli?.['parameters']).toBeUndefined();

    const geminiOnAntigravity = toolDeclaration('gemini-3-flash', 'antigravity');
    expect(geminiOnAntigravity?.['parameters']).toBeDefined();
    expect(geminiOnAntigravity?.['parametersJsonSchema']).toBeUndefined();
  });

  it('replays assistant tool calls and merges every tool result into one user turn', async () => {
    const toolCallId = 'read_file_call-1';
    const history: Message[] = [
      userMessage('read both files'),
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'I should read them', encrypted: 'c2lnbmF0dXJl' }],
        toolCalls: [
          { type: 'function', id: toolCallId, name: 'read_file', arguments: '{"path":"a.ts"}' },
          {
            type: 'function',
            id: 'read_file_call-2',
            name: 'read_file',
            arguments: '{"path":"b.ts"}',
            extras: { thought_signature_b64: 'dG9vbHNpZw==' },
          },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: 'contents of a' }], toolCalls: [], toolCallId },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'contents of b' }],
        toolCalls: [],
        toolCallId: 'read_file_call-2',
      },
    ];
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    await collect(await provider.generate('sys', [], history));

    const body = requests[0]!.body as unknown as {
      request: { contents: { role: string; parts: Record<string, unknown>[] }[] };
    };
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'read both files' }] },
      {
        role: 'model',
        parts: [
          { thought: true, text: 'I should read them', thoughtSignature: 'c2lnbmF0dXJl' },
          // The first call of the turn is unsigned, so it is healed with the
          // bypass sentinel; the signed sibling keeps its own signature.
          {
            functionCall: { name: 'read_file', args: { path: 'a.ts' } },
            thoughtSignature: 'skip_thought_signature_validator',
          },
          {
            functionCall: { name: 'read_file', args: { path: 'b.ts' } },
            thoughtSignature: 'dG9vbHNpZw==',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { output: 'contents of a' } } },
          { functionResponse: { name: 'read_file', response: { output: 'contents of b' } } },
        ],
      },
    ]);
  });

  it('builds the same envelope through the public request builder', () => {
    const body = buildCloudCodeAssistRequest({
      model: 'gemini-3-flash',
      projectId: 'proj-123',
      systemPrompt: 'sys',
      tools: [],
      history: [userMessage('hi')],
      variant: 'gemini-cli',
      thinking: { includeThoughts: true, thinkingLevel: 'HIGH' },
      session: {},
    });

    expect(body.model).toBe('gemini-3-flash');
    expect(body.request.generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
    });
  });
});

describe('Cloud Code Assist thought signatures', () => {
  const SENTINEL = 'skip_thought_signature_validator';

  it('heals an unsigned first call and leaves a signed first call alone', () => {
    const unsigned = replayedModelParts('gemini-3-flash', [
      assistantTurn([functionCall('grep', 'call-1', { pattern: 'shift' })]),
    ]);
    expect(unsigned).toEqual([
      {
        functionCall: { name: 'grep', args: { pattern: 'shift' } },
        thoughtSignature: SENTINEL,
      },
    ]);

    const parallel = replayedModelParts('gemini-3.1-pro-preview', [
      assistantTurn([
        {
          ...functionCall('todo', 'call-1', { op: 'init' }),
          extras: { thought_signature_b64: 'QUJDRA==' },
        },
        functionCall('grep', 'call-2', { pattern: 'shift' }),
        functionCall('grep', 'call-3', { pattern: 'helperExec' }),
      ]),
    ]);
    expect(parallel).toHaveLength(3);
    // A signed first call keeps its signature and the unsigned parallel calls
    // after it stay bare — the host accepts those.
    expect(parallel[0]?.thoughtSignature).toBe('QUJDRA==');
    expect(parallel[1]?.thoughtSignature).toBeUndefined();
    expect(parallel[2]?.thoughtSignature).toBeUndefined();
  });

  it('replays only well-formed thought signatures', () => {
    // Not a base64-aligned length.
    const shortSignature = {
      ...functionCall('grep', 'call-1', { pattern: 'a' }),
      extras: { thought_signature_b64: 'QUJDR' },
    };
    expect(
      replayedModelParts('gemini-3-flash', [assistantTurn([shortSignature])])[0]?.thoughtSignature,
    ).toBe(SENTINEL);

    // A base64-aligned length but a character outside the alphabet.
    const foreignAlphabet = {
      ...functionCall('grep', 'call-2', { pattern: 'a' }),
      extras: { thought_signature_b64: 'c2ln!_==' },
    };
    expect(
      replayedModelParts('gemini-3-flash', [assistantTurn([foreignAlphabet])])[0]?.thoughtSignature,
    ).toBe(SENTINEL);

    // A well-formed signature still travels unchanged.
    const wellFormed = {
      ...functionCall('grep', 'call-3', { pattern: 'a' }),
      extras: { thought_signature_b64: 'QUJDRA==' },
    };
    expect(
      replayedModelParts('gemini-3-flash', [assistantTurn([wellFormed])])[0]?.thoughtSignature,
    ).toBe('QUJDRA==');
  });

  it('drops a malformed reasoning signature instead of replaying it', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'bad signature', encrypted: 'QUJDR' },
          { type: 'think', think: 'good signature', encrypted: 'c2ln' },
        ],
        toolCalls: [],
      },
    ];

    // The malformed signature is not replayed, but the block itself is still
    // sent bare — the hosts take an unsigned reasoning block on this surface.
    expect(replayedModelParts('gemini-3-flash', history)).toEqual([
      { thought: true, text: 'bad signature' },
      { thought: true, text: 'good signature', thoughtSignature: 'c2ln' },
    ]);
    // Where the drop rule applies, a malformed signature counts as none at all,
    // so only the well-formed block survives.
    expect(replayedModelParts('claude-sonnet-4-6', history, 'antigravity')).toEqual([
      { thought: true, text: 'good signature', thoughtSignature: 'c2ln' },
    ]);
  });

  it('replays a tool-call signature only to the model that produced it', () => {
    const signedByFlash = {
      ...functionCall('grep', 'call-1', { pattern: 'a' }),
      extras: { thought_signature_b64: 'QUJDRA==', thought_signature_model: 'gemini-3-flash' },
    };

    expect(
      replayedModelParts('gemini-3-flash', [assistantTurn([signedByFlash])])[0]?.thoughtSignature,
    ).toBe('QUJDRA==');

    // Another model: the foreign signature is dropped, and the now-unsigned
    // first call falls back to the bypass sentinel.
    expect(
      replayedModelParts('gemini-3.1-pro-preview', [assistantTurn([signedByFlash])])[0]
        ?.thoughtSignature,
    ).toBe(SENTINEL);

    // History written before the producer was recorded keeps its signature.
    const legacy = {
      ...functionCall('grep', 'call-2', { pattern: 'a' }),
      extras: { thought_signature_b64: 'QUJDRA==' },
    };
    expect(
      replayedModelParts('gemini-3.1-pro-preview', [assistantTurn([legacy])])[0]?.thoughtSignature,
    ).toBe('QUJDRA==');
  });

  it('tags a captured tool-call signature with the request model', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'call-1' },
                      thoughtSignature: 'c2ln',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        }),
      ]),
    );
    const provider = makeProvider({
      model: 'gemini-3.1-pro-preview',
      variant: 'gemini-cli',
      fetchImpl,
    });

    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));

    expect(parts[0]).toMatchObject({
      type: 'function',
      extras: {
        thought_signature_b64: 'c2ln',
        thought_signature_model: 'gemini-3.1-pro-preview',
      },
    });
  });

  it('starts the first-call exemption over on every assistant turn', () => {
    const parts = replayedModelParts('gemini-3-flash', [
      assistantTurn([functionCall('grep', 'call-1', { pattern: 'a' })]),
      assistantTurn([functionCall('grep', 'call-2', { pattern: 'b' })]),
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.thoughtSignature).toBe(SENTINEL);
    expect(parts[1]?.thoughtSignature).toBe(SENTINEL);
  });

  it('does not heal models outside the signed-first-call contract', () => {
    const legacy = replayedModelParts('gemini-2.0-flash', [
      assistantTurn([functionCall('grep', 'call-1', { pattern: 'a' })]),
    ]);
    expect(legacy[0]?.thoughtSignature).toBeUndefined();

    const claude = replayedModelParts('claude-sonnet-4-6', [
      assistantTurn([functionCall('read_file', 'call-1', { path: 'a.ts' })]),
    ]);
    expect(claude[0]?.thoughtSignature).toBeUndefined();
  });

  it('drops an unsigned reasoning block only for Claude behind Antigravity', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'unsigned plan' },
          { type: 'think', think: 'signed plan', encrypted: 'c2ln' },
        ],
        toolCalls: [],
      },
    ];

    // The Antigravity host refuses a Claude reasoning block that carries no
    // signature, so the unsigned one is not replayed at all.
    expect(replayedModelParts('claude-sonnet-4-6', history, 'antigravity')).toEqual([
      { thought: true, text: 'signed plan', thoughtSignature: 'c2ln' },
    ]);
    // The same turn on the plain host, and a Gemini model behind Antigravity,
    // keep both blocks.
    expect(replayedModelParts('claude-sonnet-4-6', history, 'gemini-cli')).toEqual([
      { thought: true, text: 'unsigned plan' },
      { thought: true, text: 'signed plan', thoughtSignature: 'c2ln' },
    ]);
    expect(replayedModelParts('gemini-3-flash', history, 'antigravity')).toHaveLength(2);
  });

  it('retains a signature that arrives in its own frame on the open reasoning block', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: { candidates: [{ content: { parts: [{ text: 'plan', thought: true }] } }] },
        }),
        sseEvent({ response: { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'c2ln' }] } }] } }),
        sseEvent({
          response: {
            candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
          },
        }),
      ]),
    );
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));
    expect(parts).toEqual([
      { type: 'think', think: 'plan' },
      { type: 'think', think: '', encrypted: 'c2ln' },
      { type: 'text', text: 'answer' },
    ]);

    // The accumulator folds the empty frame into the reasoning block it
    // continues, so the signature survives onto the replayed turn.
    const thinking: ThinkPart = { ...(parts[0] as ThinkPart) };
    expect(mergeInPlace(thinking, parts[1]!)).toBe(true);
    expect(thinking).toEqual({ type: 'think', think: 'plan', encrypted: 'c2ln' });
    const replayed = replayedModelParts('gemini-3-flash', [
      { role: 'assistant', content: [thinking], toolCalls: [] },
    ]);
    expect(replayed[0]).toEqual({ thought: true, text: 'plan', thoughtSignature: 'c2ln' });
  });

  it('does not misattribute a signature-only frame that follows visible text', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } }),
        sseEvent({ response: { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'c2ln' }] } }] } }),
        sseEvent({
          response: {
            candidates: [{ content: { parts: [{ text: ' tail' }] }, finishReason: 'STOP' }],
          },
        }),
      ]),
    );
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    // A visible-text block has no signature slot to retain it on, so the frame
    // is still dropped rather than attributed to a block that cannot carry it.
    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));
    expect(parts).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'text', text: ' tail' },
    ]);
  });
});

describe('Cloud Code Assist streaming', () => {
  it('maps text, thinking, tool calls, usage, and the response id', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }],
            modelVersion: 'gemini-3-flash-001',
            responseId: 'resp-1',
          },
        }),
        sseEvent({
          response: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'plan', thought: true, thoughtSignature: 'c2ln' }],
                },
              },
            ],
          },
        }),
        sseEvent({
          response: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'call-1' } }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 3,
              cachedContentTokenCount: 2,
            },
          },
        }),
      ]),
    );
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    const stream = await provider.generate('sys', [], [userMessage('hi')]);
    const parts = await collect(stream);

    expect(parts).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'think', think: 'plan', encrypted: 'c2ln' },
      { type: 'function', id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]);
    expect(stream.id).toBe('resp-1');
    expect(stream.model).toBe('gemini-3-flash-001');
    expect(stream.usage).toEqual({
      inputOther: 8,
      output: 3,
      inputCacheRead: 2,
      inputCacheCreation: 0,
    });
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('STOP');
  });

  it('generates an id when the stream reports a tool call without one', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [
              {
                content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
                finishReason: 'STOP',
              },
            ],
          },
        }),
      ]),
    );
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));

    expect(parts).toHaveLength(1);
    const toolCall = parts[0]!;
    if (toolCall.type !== 'function') throw new Error('expected a tool call part');
    expect(toolCall.name).toBe('read_file');
    expect(toolCall.id).toMatch(/^read_file_[0-9a-f-]+$/);
    expect(toolCall.arguments).toBe('{}');
  });

  it('maps a truncated finish reason and reports failures from in-band stream errors', async () => {
    const truncated = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }],
          },
        }),
      ]),
    );
    const truncatedProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: truncated.fetchImpl });
    const stream = await truncatedProvider.generate('sys', [], [userMessage('hi')]);
    await collect(stream);
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('MAX_TOKENS');

    const inBand = capturingFetch(() =>
      sseResponse([sseEvent({ error: { code: 429, message: 'quota exceeded' } })]),
    );
    const inBandProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: inBand.fetchImpl });
    const failure = await inBandProvider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIProviderRateLimitError);
    expect((failure as Error).message).toContain('quota exceeded');
  });

  it('parses CRLF-framed events when a chunk boundary splits a line ending', async () => {
    const raw =
      crlfEvent({ response: { candidates: [{ content: { parts: [{ text: 'one' }] } }] } }) +
      crlfEvent({
        response: {
          candidates: [{ content: { parts: [{ text: 'two' }] }, finishReason: 'STOP' }],
        },
      });
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
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));

    expect(parts).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('keeps the RPC status of an in-band stream error in the reported text', async () => {
    const statusOnly = capturingFetch(() =>
      sseResponse([sseEvent({ error: { status: 'RESOURCE_EXHAUSTED' } })]),
    );
    const statusOnlyProvider = makeProvider({
      variant: 'gemini-cli',
      fetchImpl: statusOnly.fetchImpl,
    });
    const failure = await statusOnlyProvider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatProviderError);
    expect((failure as Error).message).toContain('RESOURCE_EXHAUSTED');
    // The text-based quota classification reads the status off the message.
    expect(parseRateLimitReason((failure as Error).message)).toBe('QUOTA_EXHAUSTED');

    const both = capturingFetch(() =>
      sseResponse([
        sseEvent({ error: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }),
      ]),
    );
    const bothProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: both.fetchImpl });
    const bothFailure = await bothProvider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(bothFailure).toBeInstanceOf(APIProviderRateLimitError);
    expect((bothFailure as Error).message).toContain('quota exceeded');
    expect((bothFailure as Error).message).toContain('RESOURCE_EXHAUSTED');
  });

  it('counts thinking tokens as output and derives a missing prompt count', async () => {
    const thoughts = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 3,
              cachedContentTokenCount: 2,
              thoughtsTokenCount: 5,
              totalTokenCount: 20,
            },
          },
        }),
      ]),
    );
    const thoughtsProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: thoughts.fetchImpl });
    const thoughtsStream = await thoughtsProvider.generate('sys', [], [userMessage('hi')]);
    await collect(thoughtsStream);
    expect(thoughtsStream.usage).toEqual({
      inputOther: 10,
      output: 8,
      inputCacheRead: 2,
      inputCacheCreation: 0,
    });

    // `promptTokenCount` omitted: prompt = total - candidates - thinking.
    const derived = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              candidatesTokenCount: 4,
              thoughtsTokenCount: 6,
              totalTokenCount: 30,
            },
          },
        }),
      ]),
    );
    const derivedProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: derived.fetchImpl });
    const derivedStream = await derivedProvider.generate('sys', [], [userMessage('hi')]);
    await collect(derivedStream);
    expect(derivedStream.usage).toEqual({
      inputOther: 20,
      output: 10,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    // A cache count above the prompt is clamped, so the input never goes negative.
    const clamped = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 1,
              cachedContentTokenCount: 9,
            },
          },
        }),
      ]),
    );
    const clampedProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: clamped.fetchImpl });
    const clampedStream = await clampedProvider.generate('sys', [], [userMessage('hi')]);
    await collect(clampedStream);
    expect(clampedStream.usage).toEqual({
      inputOther: 0,
      output: 1,
      inputCacheRead: 5,
      inputCacheCreation: 0,
    });
  });

  it('surfaces a blocked prompt as a provider error', async () => {
    const { fetchImpl } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'dangerous content' },
          },
        }),
      ]),
    );
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    const failure = await provider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatProviderError);
    expect((failure as Error).message).toContain('blocked by Google (SAFETY)');
  });

  it('maps HTTP failures onto the error taxonomy', async () => {
    const forbidden = capturingFetch(() => new Response('permission denied', { status: 403 }));
    const forbiddenProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: forbidden.fetchImpl });
    const failure = await forbiddenProvider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIStatusError);
    expect((failure as APIStatusError).statusCode).toBe(403);
    expect((failure as Error).message).toContain('Cloud Code Assist API error (403)');
  });

  it('rejects an already-aborted request without touching the network', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.generate('sys', [], [userMessage('hi')], { signal: controller.signal }),
    ).rejects.toThrowError(/aborted/i);
    expect(requests).toHaveLength(0);
  });
});

describe('Cloud Code Assist endpoint policy', () => {
  it('falls back to the sandbox host and remembers the endpoint that answered', async () => {
    const { fetchImpl, requests } = capturingFetch((_request, index) =>
      index === 0 ? new Response('busy', { status: 503 }) : textResponse('recovered'),
    );
    const provider = makeProvider({
      variant: 'antigravity',
      apiKey: structuredCredentials({ endpoint: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT }),
      fetchImpl,
    });

    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));
    expect(parts).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(requests.map((request) => request.url)).toEqual([
      `${CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT}${STREAM_PATH}`,
      `${CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT}${STREAM_PATH}`,
    ]);

    // The host that answered is tried first on the next request.
    await collect(await provider.generate('sys', [], [userMessage('again')]));
    expect(requests[2]!.url).toBe(
      `${CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT}${STREAM_PATH}`,
    );
  });

  it('fails over when the host accepts the request but streams no event', async () => {
    const { fetchImpl, requests } = capturingFetch((_request, index) =>
      index === 0 ? sseResponse([]) : textResponse('recovered'),
    );
    const provider = makeProvider({
      variant: 'antigravity',
      apiKey: structuredCredentials({ endpoint: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT }),
      fetchImpl,
    });

    const parts = await collect(await provider.generate('sys', [], [userMessage('hi')]));

    expect(parts).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(requests.map((request) => request.url)).toEqual([
      `${CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT}${STREAM_PATH}`,
      `${CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT}${STREAM_PATH}`,
    ]);
  });

  it('reports an error instead of an empty success when every endpoint stays silent', async () => {
    const { fetchImpl, requests } = capturingFetch(() => sseResponse([]));
    const provider = makeProvider({
      variant: 'antigravity',
      apiKey: structuredCredentials({ endpoint: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT }),
      fetchImpl,
    });

    const failure = await provider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatProviderError);
    expect((failure as Error).message).toContain('without a finish reason');
    // Both candidate hosts were tried before giving up.
    expect(requests).toHaveLength(2);

    const single = capturingFetch(() => sseResponse([]));
    const cliProvider = makeProvider({ variant: 'gemini-cli', fetchImpl: single.fetchImpl });
    const singleFailure = await cliProvider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(singleFailure).toBeInstanceOf(ChatProviderError);
    expect((singleFailure as Error).message).toContain('without a finish reason');
    expect(single.requests).toHaveLength(1);
  });

  it('never replays a half-streamed answer onto the fallback endpoint', async () => {
    const { fetchImpl, requests } = capturingFetch((_request, index) =>
      index === 0
        ? sseResponse([
            sseEvent({ response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } }),
            sseEvent({ error: { code: 500, message: 'internal' } }),
          ])
        : textResponse('recovered'),
    );
    const provider = makeProvider({
      variant: 'antigravity',
      apiKey: structuredCredentials({ endpoint: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT }),
      fetchImpl,
    });

    const failure = await provider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);

    // The failure is reported once content has been emitted: a retry would
    // splice a second answer onto the half-streamed one.
    expect(failure).toBeInstanceOf(APIStatusError);
    expect((failure as APIStatusError).statusCode).toBe(500);
    expect((failure as Error).message).toContain('internal');
    expect(requests).toHaveLength(1);
  });

  it('does not fail over on a deterministic client error', async () => {
    const { fetchImpl, requests } = capturingFetch(() => new Response('bad request', { status: 400 }));
    const provider = makeProvider({
      variant: 'antigravity',
      apiKey: structuredCredentials({ endpoint: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT }),
      fetchImpl,
    });

    const failure = await provider
      .generate('sys', [], [userMessage('hi')])
      .then(collect)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIStatusError);
    expect(requests).toHaveLength(1);
  });

  it('uses a pinned endpoint verbatim', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({
      variant: 'antigravity',
      baseUrl: 'https://cloudcode.example.com/',
      fetchImpl,
    });

    await collect(await provider.generate('sys', [], [userMessage('hi')]));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://cloudcode.example.com${STREAM_PATH}`);
  });

  it('infers the surface from the endpoint host', () => {
    expect(inferGoogleCloudCodeVariant(CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT)).toBe(
      'antigravity',
    );
    expect(inferGoogleCloudCodeVariant(CLOUD_CODE_ASSIST_ANTIGRAVITY_SANDBOX_ENDPOINT)).toBe(
      'antigravity',
    );
    expect(inferGoogleCloudCodeVariant(CLOUD_CODE_ASSIST_DEFAULT_ENDPOINT)).toBe('gemini-cli');
    expect(inferGoogleCloudCodeVariant(undefined)).toBe('gemini-cli');
  });
});

describe('Cloud Code Assist credentials', () => {
  it('parses the structured credential and tolerates the project_id alias', () => {
    expect(parseGoogleCloudCodeCredentials(structuredCredentials({ email: 'dev@example.com' }))).toEqual(
      { token: 'access-token', projectId: 'proj-123', email: 'dev@example.com' },
    );
    expect(parseGoogleCloudCodeCredentials(JSON.stringify({ token: 't', project_id: 'proj-alias' }))).toEqual(
      { token: 't', projectId: 'proj-alias' },
    );
    // A mistyped primary field falls back to the alias…
    expect(
      parseGoogleCloudCodeCredentials(JSON.stringify({ token: 't', projectId: 42, project_id: 'fallback' })),
    ).toEqual({ token: 't', projectId: 'fallback' });
    // …while an empty primary field is reported instead of silently replaced.
    expect(() =>
      parseGoogleCloudCodeCredentials(JSON.stringify({ token: 't', projectId: '', project_id: 'fallback' })),
    ).toThrowError(/login/);
  });

  it('rejects a non-JSON credential with a sign-in hint, before any request', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({ apiKey: 'plain-access-token', variant: 'gemini-cli', fetchImpl });

    await expect(provider.generate('sys', [], [userMessage('hi')])).rejects.toThrowError(
      /credentials must be a JSON object[\s\S]*\/login/,
    );
    expect(requests).toHaveLength(0);
  });

  it('rejects a credential that is missing token or projectId', async () => {
    const { fetchImpl } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({
      apiKey: JSON.stringify({ token: 't' }),
      variant: 'gemini-cli',
      fetchImpl,
    });

    await expect(provider.generate('sys', [], [userMessage('hi')])).rejects.toThrowError(
      /missing token or projectId[\s\S]*\/login/,
    );
  });

  it('prefers the credential endpoint over the configured base URL', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({
      baseUrl: 'https://ignored.example.com',
      apiKey: structuredCredentials({ endpoint: 'https://cloudcode.example.com/' }),
      variant: 'gemini-cli',
      fetchImpl,
    });

    await collect(await provider.generate('sys', [], [userMessage('hi')]));

    expect(requests[0]!.url).toBe(`https://cloudcode.example.com${STREAM_PATH}`);
  });

  it('reads request-scoped credentials from the auth channel', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl });

    await collect(
      await provider.generate('sys', [], [userMessage('hi')], {
        auth: {
          apiKey: structuredCredentials({ token: 'request-token', endpoint: 'https://auth.example.com' }),
        },
      }),
    );

    expect(requests[0]!.url).toBe(`https://auth.example.com${STREAM_PATH}`);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer request-token');
  });
});

describe('Cloud Code Assist provider surface', () => {
  it('remembers the response id for the next antigravity turn', async () => {
    const { fetchImpl, requests } = capturingFetch(() =>
      sseResponse([
        sseEvent({
          response: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'first' }] }, finishReason: 'STOP' }],
            responseId: 'resp-1',
          },
        }),
      ]),
    );
    const provider = makeProvider({
      variant: 'antigravity',
      baseUrl: CLOUD_CODE_ASSIST_ANTIGRAVITY_DAILY_ENDPOINT,
      fetchImpl,
    });

    await collect(await provider.generate('sys', [], [userMessage('hi')]));
    await collect(await provider.generate('sys', [], [userMessage('hi again')]));

    const first = requests[0]!.body as unknown as { request: { labels?: Record<string, string> } };
    const second = requests[1]!.body as unknown as { request: { labels?: Record<string, string> } };
    expect(first.request.labels?.['last_execution_id']).toBeUndefined();
    expect(second.request.labels?.['last_execution_id']).toBe('resp-1');
    expect(second.request.labels?.['last_step_index']).toBe('2');
    expect(second.request.labels?.['trajectory_id']).toBe(first.request.labels?.['trajectory_id']);
  });

  it('maps thinking effort onto the per-model generation config', async () => {
    const { fetchImpl, requests } = capturingFetch(() => textResponse('ok'));
    const gemini3 = makeProvider({ variant: 'gemini-cli', fetchImpl }).withThinking('high');
    expect(gemini3.thinkingEffort).toBe('high');
    await collect(await gemini3.generate('sys', [], [userMessage('hi')]));
    const gemini3Body = requests[0]!.body as unknown as {
      request: { generationConfig?: { thinkingConfig?: unknown } };
    };
    expect(gemini3Body.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'HIGH',
    });

    const legacy = new GoogleCloudCodeChatProvider({
      model: 'gemini-2.0-flash',
      apiKey: structuredCredentials(),
      variant: 'gemini-cli',
      fetch: fetchImpl,
    }).withThinking('off');
    expect(legacy.thinkingEffort).toBe('off');
    await collect(await legacy.generate('sys', [], [userMessage('hi')]));
    const legacyBody = requests[1]!.body as unknown as {
      request: { generationConfig?: { thinkingConfig?: unknown } };
    };
    expect(legacyBody.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });

    // A clone shares the conversation state but carries its own thinking level.
    expect(makeProvider({ variant: 'gemini-cli', fetchImpl }).thinkingEffort).toBeNull();
  });

  it('declares capabilities per model family', () => {
    const provider = makeProvider({ variant: 'gemini-cli', fetchImpl: async () => textResponse('ok') });

    expect(provider.getCapability('gemini-3-flash').thinking).toBe(true);
    expect(provider.getCapability('gemini-3-flash').tool_use).toBe(true);
    expect(provider.getCapability('claude-sonnet-4-6').image_in).toBe(true);
    expect(provider.getCapability('mistral-large').tool_use).toBe(false);
  });

  it('is reachable through the provider factory', () => {
    const provider = createProvider({
      type: 'google-cloud-code',
      model: 'gemini-3-flash',
      apiKey: structuredCredentials(),
    });

    expect(provider).toBeInstanceOf(GoogleCloudCodeChatProvider);
    expect(provider.name).toBe('google_cloud_code');
    expect(provider.modelName).toBe('gemini-3-flash');
  });
});
