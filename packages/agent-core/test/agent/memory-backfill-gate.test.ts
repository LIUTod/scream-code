/**
 * At startup the agent embeds memos that have no vector yet. Loading the
 * embedding engine can DOWNLOAD the model, and the app's own rule is that a
 * missing model is the user's decision (a setup card), never a silent fetch. So
 * the backfill may only load the engine when the model is already on disk.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryMemoStore, createMemoryMemo } from '@scream-code/memory';

import { testAgent } from './harness/agent';

const MODEL_URL_ENV = 'SCREAM_CODE_EMBEDDING_MODEL_URL';
const MODEL_DIR = 'fast-bge-small-zh-v1.5';
const REQUIRED_FILES = ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json'];

let home: string;
let server: Server;
let hits: number;
let previousUrl: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'scream-backfill-gate-'));
  hits = 0;
  server = createServer((_request, response) => {
    hits += 1;
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  previousUrl = process.env[MODEL_URL_ENV];
  process.env[MODEL_URL_ENV] = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/model.tar.gz`;

  // A memory database with one memo and no vector, as an older version left it.
  const seed = new MemoryMemoStore(home);
  await seed.init();
  await seed.append(
    createMemoryMemo({
      userNeed: 'need',
      approach: 'approach',
      outcome: 'done',
      whatFailed: 'none',
      whatWorked: 'worked',
      extractionSource: 'manual',
      sourceSessionId: 's1',
    }),
  );
  seed.close();
});

afterEach(async () => {
  if (previousUrl === undefined) delete process.env[MODEL_URL_ENV];
  else process.env[MODEL_URL_ENV] = previousUrl;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

async function startAgent() {
  const ctx = testAgent({ screamHomeDir: home });
  await ctx.agent.memoStoreReady;
  return ctx;
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('startup memory backfill', () => {
  it('does not download the model when it is not cached', async () => {
    const ctx = await startAgent();
    await pause(400); // a load, had one started, would have requested the model by now

    expect(hits).toBe(0);
    expect(ctx.agent.memoStore?.getEmbeddingEngine()?.available).toBe(false);
  });

  it('loads the engine from disk when the model is already cached', async () => {
    const modelDir = join(home, 'cache', 'fastembed', MODEL_DIR);
    await mkdir(modelDir, { recursive: true });
    for (const file of REQUIRED_FILES) await writeFile(join(modelDir, file), 'x');

    const ctx = await startAgent();
    const engine = ctx.agent.memoStore?.getEmbeddingEngine();
    // The stand-in model files are not a real model, so the load fails — which
    // is how this test knows it was attempted — but it never goes to the network.
    const attempted = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i += 1) {
        if (engine?.lastError !== undefined) return true;
        await pause(50);
      }
      return false;
    };

    expect(await attempted()).toBe(true);
    expect(hits).toBe(0);
  });
});
