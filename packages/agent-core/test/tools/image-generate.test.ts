/**
 * Tests for ImageGenerateTool — config gating, stream-first fallback,
 * response extraction shapes, session bookkeeping, and the invariant that
 * the API key never appears in outputs or session state.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Jian } from '@scream-code/jian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutableToolResult } from '../../src/loop';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import {
  ImageGenerateTool,
  extractImagePayload,
  type ImageGenerateInput,
} from '../../src/tools/builtin/image/image-generate';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const API_KEY = 'sk-unit-test-secret-key';

// 1×1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B64 = PNG_BYTES.toString('base64');

let home: string;
let work: string;

async function writeConfig(overrides: Record<string, string> = {}): Promise<void> {
  await writeFile(
    join(home, 'image-config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      url: 'https://gateway.example/v1/images/generations',
      api_key: API_KEY,
      model: 'gpt-image-2',
      size: 'auto',
      ...overrides,
    }),
    'utf8',
  );
}

function makeTool(): ImageGenerateTool {
  const jian = {
    pathClass: () => 'posix',
    gethome: () => home,
    realpath: async (path: string) => path,
  } as unknown as Jian;
  const workspace: WorkspaceConfig = { workspaceDir: work, additionalDirs: [] };
  return new ImageGenerateTool(work, home, jian, workspace);
}

async function run(args: ImageGenerateInput, execSignal: AbortSignal = signal): Promise<ExecutableToolResult> {
  return executeTool(makeTool(), {
    turnId: 't1',
    toolCallId: 'call_1',
    args,
    signal: execSignal,
  });
}

function outputText(result: ExecutableToolResult): string {
  return typeof result.output === 'string' ? result.output : '';
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(responses: Array<Response | ((init: RequestInit) => Response)>): FetchCall[] {
  const calls: FetchCall[] = [];
  let index = 0;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('stubFetch: no response queued');
    return typeof next === 'function' ? next(init ?? {}) : next;
  });
  return calls;
}

function callAt(calls: FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`missing fetch call #${index}`);
  return call;
}

/** JSON request bodies are always sent as plain strings by this tool. */
function bodyText(call: FetchCall): string {
  const body = call.init.body;
  return typeof body === 'string' ? body : '';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'image-home-'));
  work = await mkdtemp(join(tmpdir(), 'image-work-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe('extractImagePayload', () => {
  it('reads top-level b64_json, data-array b64_json, and data-array url', () => {
    expect(extractImagePayload({ b64_json: 'AAA' })).toEqual({ b64: 'AAA' });
    expect(extractImagePayload({ data: [{ b64_json: 'BBB' }] })).toEqual({ b64: 'BBB' });
    expect(extractImagePayload({ data: [{ url: 'https://cdn.example/x.png' }] })).toEqual({
      url: 'https://cdn.example/x.png',
    });
    expect(extractImagePayload({ data: [{ revised_prompt: 'no image' }] })).toBeUndefined();
    expect(extractImagePayload('garbage')).toBeUndefined();
  });

  it('skips empty placeholder fields instead of returning them', () => {
    // Relay gateways send `{"b64_json":"","url":"…"}`; the empty placeholder
    // must never outrank the field that actually holds the image.
    expect(extractImagePayload({ b64_json: '', url: 'https://cdn.example/x.png' })).toEqual({
      url: 'https://cdn.example/x.png',
    });
    expect(
      extractImagePayload({ data: [{ b64_json: '', revised_prompt: '', url: 'https://cdn.example/x.png' }] }),
    ).toEqual({ url: 'https://cdn.example/x.png' });
    expect(extractImagePayload({ b64_json: '   ', data: [{ b64_json: 'AAA' }] })).toEqual({ b64: 'AAA' });
    expect(extractImagePayload({ b64_json: '', url: '' })).toBeUndefined();
  });

  it('keeps b64 ahead of url when both carry data', () => {
    expect(extractImagePayload({ b64_json: 'AAA', url: 'https://cdn.example/x.png' })).toEqual({ b64: 'AAA' });
  });
});

describe('config gating', () => {
  it('returns a /config image guided error when the config file is missing', async () => {
    const result = await run({ mode: 'new', prompt: 'a red cube', session: 's1' });
    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('/config image');
    expect(outputText(result)).not.toContain(API_KEY);
  });

  it('treats a placeholder key as unconfigured', async () => {
    await writeConfig({ api_key: 'api_key": "replace-with-your-api-key' });
    const result = await run({ mode: 'new', prompt: 'a red cube', session: 's1' });
    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('/config image');
  });

  it('rejects mode=edit without imagePaths', async () => {
    await writeConfig();
    const result = await run({ mode: 'edit', prompt: 'make it blue', session: 's1' });
    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('imagePaths');
  });

  it('rejects session names that could escape the sessions directory', async () => {
    await writeConfig();
    for (const session of ['../evil', 'a/b', 'a\\b', '..', '.']) {
      const result = await run({ mode: 'new', prompt: 'probe', session });
      expect(result.isError).toBe(true);
      expect(outputText(result)).toContain('Invalid session name');
    }
  });

  it('refuses image-to-image for the text-to-image-only preset provider', async () => {
    await writeConfig({ provider: 'volcengine' });
    const result = await run({ mode: 'edit', prompt: 'x', imagePaths: [join(work, 'x.png')], session: 's1' });
    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('text-to-image only');
  });

  it('blocks sensitive files outside any path before the request is sent', async () => {
    await writeConfig();
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({
      mode: 'edit',
      prompt: 'exfil probe',
      imagePaths: [join(home, 'id_rsa')],
      session: 's1',
    });

    expect(result.isError).toBe(true);
    expect(outputText(result)).toMatch(/sensitive/i);
    expect(calls).toHaveLength(0);
  });

  it('accepts TUI-materialized attachment files outside the workspace', async () => {
    await writeConfig();
    const attachment = join(tmpdir(), 'scream-attachment-unit-test.png');
    await writeFile(attachment, PNG_BYTES);
    stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({
      mode: 'edit',
      prompt: 'attachment probe',
      imagePaths: [attachment],
      session: 's-att',
    });

    expect(result.isError).toBeFalsy();
    expect(outputText(result)).toContain('turn-001.png');
    await rm(attachment, { force: true });
  });

  it('short-circuits without any fetch when the turn is already cancelled', async () => {
    await writeConfig();
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);
    const cancelled = new AbortController();
    cancelled.abort();

    const result = await run({ mode: 'new', prompt: 'probe', session: 's1' }, cancelled.signal);

    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('Cancelled.');
    expect(calls).toHaveLength(0);
  });
});

describe('new mode', () => {
  it('generates via stream-first JSON and saves the PNG without leaking the key', async () => {
    await writeConfig();
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'new', prompt: 'a red cube on a desk', session: 'unit' });

    expect(result.isError).toBeFalsy();
    const output = outputText(result);
    expect(output).toContain('Image saved:');
    expect(output).toContain(join('outputs', 'image', 'unit', 'turn-001.png'));
    expect(output).not.toContain(API_KEY);

    // Stream was requested first, with the key only in the header.
    expect(calls).toHaveLength(1);
    const first = callAt(calls, 0);
    expect(first.url).toBe('https://gateway.example/v1/images/generations');
    expect((first.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(bodyText(first)) as Record<string, unknown>;
    expect(body['stream']).toBe(true);
    expect(body['prompt']).toBe('a red cube on a desk');

    // File on disk matches the payload.
    const saved = await readFile(join(work, 'outputs', 'image', 'unit', 'turn-001.png'));
    expect(Buffer.compare(saved, PNG_BYTES)).toBe(0);

    // Session state records metadata only — no key.
    const sessionText = await readFile(join(home, 'image-sessions', 'unit.json'), 'utf8');
    expect(sessionText).toContain('turn-001.png');
    expect(sessionText).not.toContain(API_KEY);
    const pointer = await readFile(join(home, 'image-sessions', 'current-session'), 'utf8');
    expect(pointer.trim()).toBe('unit');
  });

  it('falls back to a synchronous request when the gateway rejects stream params', async () => {
    await writeConfig();
    const calls = stubFetch([
      jsonResponse({ error: { message: "Unknown parameter: 'stream'." } }, 400),
      jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
    ]);

    const result = await run({ mode: 'new', prompt: 'fallback probe', session: 'fallback' });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    const firstBody = JSON.parse(bodyText(callAt(calls, 0))) as Record<string, unknown>;
    const secondBody = JSON.parse(bodyText(callAt(calls, 1))) as Record<string, unknown>;
    expect(firstBody['stream']).toBe(true);
    expect(secondBody['stream']).toBeUndefined();
  });

  it('also falls back when only partial_images is rejected', async () => {
    await writeConfig();
    const calls = stubFetch([
      jsonResponse({ error: { message: "Unknown parameter: 'partial_images'." } }, 400),
      jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
    ]);

    const result = await run({ mode: 'new', prompt: 'partial fallback', session: 'partial' });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
  });

  it('parses an SSE stream body carrying the final image', async () => {
    await writeConfig();
    const sse =
      `data: {"type":"image_generation.in_progress"}\n\n` +
      `data: {"type":"image_generation.completed","result":{"b64_json":"${PNG_B64}"}}\n\n`;
    stubFetch([
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);

    const result = await run({ mode: 'new', prompt: 'sse probe', session: 'sse' });
    expect(result.isError).toBeFalsy();
    expect(outputText(result)).toContain('turn-001.png');
  });

  it('keeps the final SSE event even when the stream ends without a trailing newline', async () => {
    await writeConfig();
    // Connection closes right after the last data line — no blank separator.
    const sse = `data: {"type":"image_generation.completed","result":{"b64_json":"${PNG_B64}"}}`;
    stubFetch([
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);

    const result = await run({ mode: 'new', prompt: 'sse tail probe', session: 'sse-tail' });
    expect(result.isError).toBeFalsy();
    expect(outputText(result)).toContain('turn-001.png');
  });

  it.skipIf(process.platform === 'win32')('creates the config-independent session files with 0600', async () => {
    await writeConfig();
    stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'new', prompt: 'perm probe', session: 'perm' });
    expect(result.isError).toBeFalsy();
    const sessionFile = await stat(join(home, 'image-sessions', 'perm.json'));
    expect(sessionFile.mode & 0o777).toBe(0o600);
  });

  it('reads legacy base_url configs by composing the generations endpoint', async () => {
    await writeFile(
      join(home, 'image-config.json'),
      JSON.stringify({
        provider: 'openai-compatible',
        base_url: 'https://legacy.example/v1',
        api_key: API_KEY,
        model: 'gpt-image-2',
        size: 'auto',
      }),
      'utf8',
    );
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'new', prompt: 'legacy probe', session: 'legacy' });

    expect(result.isError).toBeFalsy();
    expect(callAt(calls, 0).url).toBe('https://legacy.example/v1/images/generations');
  });

  it('sends the configured full URL exactly, without appending any path', async () => {
    await writeConfig({ url: 'https://relay.example.com/api/v2/gen-image' });
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'new', prompt: 'verbatim url', session: 'verbatim' });

    expect(result.isError).toBeFalsy();
    expect(callAt(calls, 0).url).toBe('https://relay.example.com/api/v2/gen-image');
  });

  it('downloads the image when the response carries a URL', async () => {
    await writeConfig();
    const calls = stubFetch([
      jsonResponse({ data: [{ url: 'https://cdn.example/pic.png' }] }),
      new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    ]);

    const result = await run({ mode: 'new', prompt: 'url probe', session: 'url' });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(callAt(calls, 1).url).toBe('https://cdn.example/pic.png');
    const saved = await readFile(join(work, 'outputs', 'image', 'url', 'turn-001.png'));
    expect(Buffer.compare(saved, PNG_BYTES)).toBe(0);
  });

  it('uses the URL when the gateway fills b64_json with an empty placeholder', async () => {
    // Real relay shape: `{"b64_json":"","revised_prompt":"","url":"…"}`. Taking
    // the empty placeholder wrote a zero-byte PNG and still reported success.
    await writeConfig();
    const calls = stubFetch([
      jsonResponse({ created: 1, data: [{ b64_json: '', revised_prompt: '', url: 'https://cdn.example/real.png' }] }),
      new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    ]);

    const result = await run({ mode: 'new', prompt: 'placeholder probe', session: 'placeholder' });

    expect(result.isError).toBeFalsy();
    expect(callAt(calls, 1).url).toBe('https://cdn.example/real.png');
    const saved = await readFile(join(work, 'outputs', 'image', 'placeholder', 'turn-001.png'));
    expect(Buffer.compare(saved, PNG_BYTES)).toBe(0);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('fails loudly instead of writing a zero-byte file when every payload field is empty', async () => {
    await writeConfig();
    stubFetch([jsonResponse({ created: 1, data: [{ b64_json: '', revised_prompt: '', url: '' }] })]);

    const result = await run({ mode: 'new', prompt: 'empty probe', session: 'empty' });

    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('no image data');
    await expect(stat(join(work, 'outputs', 'image', 'empty', 'turn-001.png'))).rejects.toThrow();
    await expect(stat(join(home, 'image-sessions', 'empty.json'))).rejects.toThrow();
  });

  it('treats an empty placeholder SSE event as carrying no image', async () => {
    await writeConfig();
    const sse =
      `data: {"type":"image_generation.partial_image","b64_json":"${PNG_B64}"}\n\n` +
      `data: {"type":"image_generation.completed","result":{"b64_json":""}}\n\n`;
    stubFetch([new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })]);

    const result = await run({ mode: 'new', prompt: 'sse placeholder probe', session: 'sse-placeholder' });

    expect(result.isError).toBeFalsy();
    const saved = await readFile(join(work, 'outputs', 'image', 'sse-placeholder', 'turn-001.png'));
    expect(Buffer.compare(saved, PNG_BYTES)).toBe(0);
  });

  it('strips a data-URL prefix instead of decoding it into the PNG', async () => {
    await writeConfig();
    stubFetch([jsonResponse({ data: [{ b64_json: `data:image/png;base64,${PNG_B64}` }] })]);

    const result = await run({ mode: 'new', prompt: 'data url probe', session: 'data-url' });

    expect(result.isError).toBeFalsy();
    const saved = await readFile(join(work, 'outputs', 'image', 'data-url', 'turn-001.png'));
    expect(Buffer.compare(saved, PNG_BYTES)).toBe(0);
  });

  it('rejects a payload that is not an image instead of saving garbage', async () => {
    await writeConfig();
    const html = Buffer.from('<html><body>gateway error</body></html>', 'utf8').toString('base64');
    stubFetch([jsonResponse({ data: [{ b64_json: html }] })]);

    const result = await run({ mode: 'new', prompt: 'garbage probe', session: 'garbage' });

    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('is not an image');
    await expect(stat(join(work, 'outputs', 'image', 'garbage', 'turn-001.png'))).rejects.toThrow();
  });
});

describe('edit / continue modes', () => {
  it('uploads the reference image as multipart and increments the turn counter', async () => {
    await writeConfig();
    const inputImage = join(work, 'ref.png');
    await writeFile(inputImage, PNG_BYTES);

    let captured: FormData | undefined;
    stubFetch([
      (init: RequestInit) => {
        captured = init.body instanceof FormData ? init.body : undefined;
        return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
      },
    ]);

    const result = await run({
      mode: 'edit',
      prompt: 'Use the attached image as the base. Change the background only.',
      imagePaths: [inputImage],
      session: 'edit-thread',
    });

    expect(result.isError).toBeFalsy();
    expect(captured).toBeDefined();
    expect(captured?.get('model')).toBe('gpt-image-2');
    expect(captured?.get('prompt')).toContain('base');
    expect(captured?.get('stream')).toBe('true');
    const uploaded = captured?.get('image');
    expect(uploaded).toBeTruthy();
    expect(outputText(result)).toContain('turn-001.png');
    expect(outputText(result)).not.toContain(API_KEY);
  });

  it('feeds the previous output back in for continue mode', async () => {
    await writeConfig();
    // Seed a completed first turn.
    stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);
    const first = await run({ mode: 'new', prompt: 'seed image', session: 'thread-a' });
    expect(first.isError).toBeFalsy();

    let captured: FormData | undefined;
    stubFetch([
      (init: RequestInit) => {
        captured = init.body instanceof FormData ? init.body : undefined;
        return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
      },
    ]);

    const second = await run({ mode: 'continue', prompt: 'make it nighttime', session: 'thread-a' });
    expect(second.isError).toBeFalsy();
    expect(outputText(second)).toContain('turn-002.png');
    expect(captured).toBeDefined();
    expect(captured?.get('image')).toBeTruthy();
  });

  it('retries without size when the service rejects an explicit size', async () => {
    await writeConfig();
    const calls = stubFetch([
      jsonResponse({ error: { message: "Invalid value: '1024x1536' is not supported for size" } }, 400),
      jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
    ]);

    const result = await run({ mode: 'new', prompt: 'size probe', size: '1024x1536', session: 'size-a' });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    const firstBody = JSON.parse(bodyText(callAt(calls, 0))) as Record<string, unknown>;
    const secondBody = JSON.parse(bodyText(callAt(calls, 1))) as Record<string, unknown>;
    expect(firstBody['size']).toBe('1024x1536');
    expect(secondBody['size']).toBeUndefined();
    // The downgrade must be visible in the result, not silent.
    expect(outputText(result)).toContain('size fallback');
    expect(outputText(result)).toContain('service default');
  });

  it('retries with the fallback size when the service requires an explicit size', async () => {
    await writeConfig();
    const calls = stubFetch([
      jsonResponse({ error: { message: 'size is required' } }, 400),
      jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
    ]);

    const result = await run({ mode: 'new', prompt: 'required probe', session: 'size-b' });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(bodyText(callAt(calls, 0)))['size']).toBeUndefined();
    expect(JSON.parse(bodyText(callAt(calls, 1)))['size']).toBe('1024x1024');
    expect(outputText(result)).toContain('size fallback: used 1024x1024');
  });

  it('fails clearly when continue has no session history', async () => {
    await writeConfig();
    const result = await run({ mode: 'continue', prompt: 'anything' });
    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('mode=new first');
  });

  it('routes edits to the edit_url override when set, using it verbatim', async () => {
    await writeConfig({ edit_url: 'https://edit.example/v1/images/edits', edit_model: 'qwen-image-edit' });
    const inputImage = join(work, 'ref.png');
    await writeFile(inputImage, PNG_BYTES);

    let captured: FormData | undefined;
    const calls = stubFetch([
      (init: RequestInit) => {
        captured = init.body instanceof FormData ? init.body : undefined;
        return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
      },
    ]);

    const result = await run({
      mode: 'edit',
      prompt: 'override probe',
      imagePaths: [inputImage],
      session: 'override',
    });

    expect(result.isError).toBeFalsy();
    expect(callAt(calls, 0).url).toBe('https://edit.example/v1/images/edits');
    expect(captured?.get('model')).toBe('qwen-image-edit');
  });

  it('derives the sibling edits endpoint when edit_url is absent', async () => {
    await writeConfig();
    const inputImage = join(work, 'ref.png');
    await writeFile(inputImage, PNG_BYTES);
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'edit', prompt: 'derive probe', imagePaths: [inputImage], session: 'derive' });

    expect(result.isError).toBeFalsy();
    expect(callAt(calls, 0).url).toBe('https://gateway.example/v1/images/edits');
  });

  it('asks for an edit URL when the main URL has no derivable sibling', async () => {
    await writeConfig({ url: 'https://gateway.example/v1/generate-image' });
    const inputImage = join(work, 'ref.png');
    await writeFile(inputImage, PNG_BYTES);
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'edit', prompt: 'no derive', imagePaths: [inputImage], session: 'nod' });

    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain('edit endpoint');
    expect(calls).toHaveLength(0);
  });

  it('keeps new mode on the main URL and model even with edit overrides set', async () => {
    await writeConfig({ edit_url: 'https://edit.example/v1/images/edits', edit_model: 'qwen-image-edit' });
    const calls = stubFetch([jsonResponse({ data: [{ b64_json: PNG_B64 }] })]);

    const result = await run({ mode: 'new', prompt: 'main channel', session: 'override-new' });

    expect(result.isError).toBeFalsy();
    expect(callAt(calls, 0).url).toBe('https://gateway.example/v1/images/generations');
    const body = JSON.parse(bodyText(callAt(calls, 0))) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-image-2');
  });
});
