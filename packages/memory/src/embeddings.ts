import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extract as untar } from 'tar';
import type { MemoryMemo } from './models.js';

/**
 * Text used to generate embeddings for a memo.
 * Combines the most semantically meaningful fields.
 */
export function buildEmbeddingText(memo: MemoryMemo): string {
  return `${memo.userNeed} ${memo.approach} ${memo.whatWorked}`;
}

/** Where a load attempt currently is: bytes coming down, archive being checked,
 *  or the model being brought up in memory. */
export type EmbeddingLoadProgress =
  | { readonly phase: 'download'; readonly received: number; readonly total?: number }
  | { readonly phase: 'verify' }
  | { readonly phase: 'load' };

export type EmbeddingProgressListener = (progress: EmbeddingLoadProgress) => void;

export interface EmbeddingEngine {
  /** Whether the model is loaded in memory and ready to embed. */
  readonly available: boolean;

  /**
   * Stable identity of the embedding model producing the vectors (e.g.
   * "bge-small-zh-v1.5"). Persisted alongside stored vectors so consumers can
   * detect a model change instead of silently comparing incompatible spaces.
   */
  readonly modelName: string;

  /** Last load/download error message, if any. */
  readonly lastError?: string;

  /**
   * Generate embeddings for a batch of texts.
   * Returns null if the engine failed to load or the model is unavailable.
   */
  embedBatch(texts: string[]): Promise<Float32Array[] | null>;

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number;

  /**
   * Proactively trigger model loading (downloads the model on first call).
   * Returns true if the engine is ready for embedding, false on failure.
   * Safe to call multiple times; failed loads can be retried.
   */
  ensureReady(): Promise<boolean>;

  /**
   * Observe an in-flight load: byte progress while the archive downloads, then
   * the verify and load phases. Pass undefined to detach. Optional so existing
   * engine fakes in tests keep compiling.
   */
  setProgressListener?(listener: EmbeddingProgressListener | undefined): void;
}

/**
 * Cache of created engines keyed by cacheDir.
 * Guarantees that all callers sharing the same cacheDir reuse the same engine
 * instance and the same in-flight model download/load — avoiding duplicate
 * downloads and file-corruption races when /memory and /knowledge both start
 * before the model is cached.
 */
const engineCache = new Map<string, EmbeddingEngine>();

/**
 * Create an embedding engine backed by the in-process WASM pipeline.
 * Lazily loads the model on first use so startup is not blocked.
 * Engines are cached by cacheDir so repeated calls with the same cacheDir
 * return the same instance, sharing model state and download progress.
 * @param cacheDir Absolute path for model cache (e.g. ~/.scream-code/cache/fastembed).
 *                 Defaults to "local_cache" (CWD-relative) if not provided — prefer
 *                 passing an explicit path so the cache doesn't duplicate across CWDs.
 */
export function createEmbeddingEngine(cacheDir?: string): EmbeddingEngine {
  // Normalize once: callers build the path with different join helpers (same
  // directory, different separators on Windows), and two keys would mean two
  // engines loading the same 94MB model — and two downloaders racing on one
  // staging file.
  const key = cacheDir === undefined ? '' : resolve(cacheDir);
  const cached = engineCache.get(key);
  if (cached !== undefined) return cached;
  const engine = createEmbeddingEngineImpl(cacheDir);
  engineCache.set(key, engine);
  return engine;
}

/**
 * @deprecated Renamed to {@link createEmbeddingEngine} when the engine moved to
 * the WASM pipeline. Kept as an alias for one release cycle so external callers
 * (SDK consumers, older tests) keep compiling.
 */
export const createFastEmbedEngine = createEmbeddingEngine;

/** Stable identity of the model used by every engine created here. */
export const EMBEDDING_MODEL_NAME = 'bge-small-zh-v1.5';

function createEmbeddingEngineImpl(cacheDir?: string): EmbeddingEngine {
  let embedder: EmbeddingRuntime | null = null;
  let initPromise: Promise<EmbeddingRuntime | null> | null = null;
  let loadFailed = false;
  let lastError: string | undefined;
  let progressListener: EmbeddingProgressListener | undefined;

  return {
    modelName: EMBEDDING_MODEL_NAME,

    get available(): boolean {
      return embedder !== null && !loadFailed;
    },

    get lastError(): string | undefined {
      return lastError;
    },

    setProgressListener(listener: EmbeddingProgressListener | undefined): void {
      progressListener = listener;
    },

    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      if (!this.available) return null;
      if (texts.length === 0) return [];

      try {
        const generator = embedder!.embed(texts);

        const vectors: Float32Array[] = [];
        for await (const batch of generator) {
          for (const vec of batch) {
            vectors.push(new Float32Array(vec));
          }
        }
        return vectors.length > 0 ? vectors : null;
      } catch (error: unknown) {
        // A runtime failure of one batch is NOT a load failure. Marking
        // loadFailed here would permanently degrade this shared engine (and
        // with it both /memory and /knowledge vector search). Keep the error
        // for diagnostics; the caller retries on the next flush.
        lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
    },

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    },

    async ensureReady(): Promise<boolean> {
      if (embedder !== null) {
        loadFailed = false;
        lastError = undefined;
        return true;
      }
      try {
        // Reuse in-flight load, or start a fresh one. If a previous load
        // resolved to null (loadFailed), clear it first so we actually retry.
        if (loadFailed || initPromise === null) {
          loadFailed = false;
          lastError = undefined;
          initPromise = loadEmbeddingRuntime(cacheDir, (progress) => progressListener?.(progress));
        }
        embedder = await initPromise;
        if (embedder === null) {
          initPromise = null;
          lastError = 'embedding runtime returned an empty session';
          return false;
        }
        loadFailed = false;
        lastError = undefined;
        return true;
      } catch (error: unknown) {
        // A MODEL-LOAD failure is a load failure: mark it so `available`
        // reports false and the next ensureReady() actually retries the load
        // (instead of silently recycling a failed embedder). Runtime embed
        // batch failures (embedBatch) intentionally do NOT set this flag —
        // they retry on the next flush.
        initPromise = null;
        loadFailed = true;
        lastError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
  };
}

/** Maximum tokens per text; matches the model's position-embedding limit. */
const MAX_SEQ_LEN = 512;
/** Texts per inference batch: 16 × 512 × 512 floats ≈ 16MB of activations. */
const EMBED_BATCH_SIZE = 16;
/** Threads for the WASM backend. One keeps resolution deterministic in packaged
 *  builds; `SCREAM_CODE_EMBEDDING_THREADS=4` is the supported opt-in. */
const EMBEDDING_THREADS_ENV = 'SCREAM_CODE_EMBEDDING_THREADS';

interface EmbeddingRuntime {
  embed(textStrings: string[]): AsyncGenerator<number[][], void, unknown>;
}

interface EncodedText {
  readonly index: number;
  readonly ids: number[];
  readonly types: number[];
}

/**
 * Token-level truncation that keeps the sentence boundary tokens.
 *
 * The tokenizer package does not apply the truncation policy itself and the
 * model package ships no truncation config, so this is the only place it can
 * happen. Keeping the head (which starts with `[CLS]`) and re-appending the
 * trailing special token (`[SEP]`) mirrors what a HuggingFace pipeline would
 * produce; slicing the tail off blindly would feed the encoder a sentence that
 * never closes and drift from the reference vectors on long inputs.
 */
function truncateEncoded(ids: readonly number[], types: readonly number[]): { ids: number[]; types: number[] } {
  if (ids.length <= MAX_SEQ_LEN) {
    return { ids: [...ids], types: [...types] };
  }
  const headSize = MAX_SEQ_LEN - 1;
  const head = ids.slice(0, headSize);
  const headTypes = types.slice(0, headSize);
  return {
    ids: [...head, ids.at(-1)!],
    types: [...headTypes, types.at(-1)!],
  };
}

/**
 * Builds the embedding runtime in-process on `onnxruntime-web` (WASM) and the
 * pure-JS tokenizer. No native binaries, no install scripts: the whole stack is
 * JavaScript plus one WebAssembly artifact resolved from the package.
 *
 * The numeric pipeline is load-bearing and must stay compatible with the
 * reference embeddings of this model: token ids come from `tokenizer.json`, and
 * the sentence vector is the **CLS token** hidden state (`last_hidden_state[0]`)
 * followed by L2 normalization. Mean pooling produces visibly different vectors
 * (cosine ≈ 0.9 against the reference), so pooling is not a stylistic choice.
 */
async function createWasmRuntime(modelDir: string): Promise<EmbeddingRuntime | null> {
  const ort = await import('onnxruntime-web');
  const { Tokenizer } = await import('@huggingface/tokenizers');
  // Leave `env.wasm.wasmPaths` at its default: the runtime resolves the wasm
  // assets relative to its own module URL internally. Assigning a filesystem
  // path there breaks on Windows, where a plain `C:\…` string is not a valid
  // ESM specifier for the dynamic import the runtime performs.
  const requestedThreads = Number(process.env[EMBEDDING_THREADS_ENV]);
  ort.env.wasm.numThreads = Number.isFinite(requestedThreads) && requestedThreads > 0
    ? requestedThreads
    : 1;
  ort.env.logLevel = 'error';

  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8')),
    JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')),
  );
  const session = await ort.InferenceSession.create(
    readFileSync(join(modelDir, 'model_optimized.onnx')),
    { executionProviders: ['wasm'] },
  );
  // Surfaced to the caller as "empty session" instead of a later TypeError.
  if (session === null || session === undefined) return null;

  return {
    async *embed(textStrings: string[]): AsyncGenerator<number[][], void, unknown> {
      if (textStrings.length === 0) return;

      const encoded: EncodedText[] = textStrings.map((text, index) => {
        const encoding = tokenizer.encode(text, { return_token_type_ids: true });
        const types = encoding.token_type_ids ?? encoding.ids.map(() => 0);
        const truncated = truncateEncoded(encoding.ids, types);
        return { index, ids: truncated.ids, types: truncated.types };
      });
      const results: number[][] = Array.from<number[]>({ length: textStrings.length });

      // Park the longest texts together so padding inside a batch stays small,
      // then put every vector back at its original index: `embedBatch` flattens
      // in yield order, and a mismatch here would attach the wrong vector to
      // the wrong memo.
      const buckets = encoded.toSorted((a, b) => a.ids.length - b.ids.length);
      for (let start = 0; start < buckets.length; start += EMBED_BATCH_SIZE) {
        const group = buckets.slice(start, start + EMBED_BATCH_SIZE);
        const rows = group.length;
        const width = Math.max(...group.map((entry) => entry.ids.length));
        const ids = new BigInt64Array(rows * width);
        const mask = new BigInt64Array(rows * width);
        const types = new BigInt64Array(rows * width);
        group.forEach((entry, row) => {
          for (let column = 0; column < width; column++) {
            const offset = row * width + column;
            ids[offset] = BigInt(column < entry.ids.length ? entry.ids[column]! : 0);
            mask[offset] = column < entry.ids.length ? 1n : 0n;
            types[offset] = BigInt(column < entry.types.length ? entry.types[column]! : 0);
          }
        });

        const output = await session.run({
          input_ids: new ort.Tensor('int64', ids, [rows, width]),
          attention_mask: new ort.Tensor('int64', mask, [rows, width]),
          token_type_ids: new ort.Tensor('int64', types, [rows, width]),
        });
        const hidden = output['last_hidden_state'] ?? output[Object.keys(output)[0]!]!;
        const dims = hidden.dims as number[];
        const hiddenSize = dims.at(-1)!;
        const data = hidden.data as Float32Array;
        group.forEach((entry, row) => {
          const rowStart = row * width * hiddenSize;
          const vector = Array.from(data.subarray(rowStart, rowStart + hiddenSize));
          let norm = 0;
          for (const value of vector) norm += value * value;
          norm = Math.sqrt(norm) || 1;
          for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm;
          results[entry.index] = vector;
        });
      }

      for (let start = 0; start < results.length; start += EMBED_BATCH_SIZE) {
        yield results.slice(start, start + EMBED_BATCH_SIZE);
      }
    },
  };
}

async function loadEmbeddingRuntime(
  cacheDir?: string,
  emit?: (progress: EmbeddingLoadProgress) => void,
): Promise<EmbeddingRuntime | null> {
  if (cacheDir === undefined) {
    // No cache dir handed in: keep the previous contract and read the model
    // from the CWD-relative legacy location.
    emit?.({ phase: 'load' });
    return createWasmRuntime(join('local_cache', BGESMALLZH_CACHE_NAME));
  }
  mkdirSync(cacheDir, { recursive: true });
  // Stage the payload ourselves when it is missing: the runtime only loads from
  // disk, so a missing cache would otherwise surface as a bare ENOENT.
  await ensureEmbeddingModelFiles(cacheDir, {
    onProgress: (received, total) => {
      emit?.(total === undefined
        ? { phase: 'download', received }
        : { phase: 'download', received, total });
    },
    onPhase: (phase) => {
      if (phase === 'verify') emit?.({ phase: 'verify' });
    },
  });
  emit?.({ phase: 'load' });
  return createWasmRuntime(join(cacheDir, BGESMALLZH_CACHE_NAME));
}

/**
 * Cache entry name for the fixed BGESmallZH model: the staged archive extracts
 * to `<cacheDir>/<name>/` and the runtime loads from that directory.
 */
const BGESMALLZH_CACHE_NAME = 'fast-bge-small-zh-v1.5';

/** Files the runtime needs before the model can be considered installed. */
const EMBEDDING_REQUIRED_FILES = ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json'] as const;

/**
 * First-party model payload source (GitHub Releases asset; sha256-pinned).
 *
 * The runtime loads strictly from disk, so this downloader is the only path
 * that fetches model bytes. It validates the HTTP status, extracts with the
 * bundled tar implementation and verifies the weights payload against a pinned
 * sha256 — an error page or a truncated archive can never masquerade as an
 * installed model (which is how installs used to end up with a cache directory
 * that made the setup card reappear on every startup).
 */
export const EMBEDDING_MODEL_SOURCE_URL =
  'https://github.com/LIUTod/scream-code/releases/download/embedding-models-v1/fast-bge-small-zh-v1.5.tar.gz';

/** Escape hatch for air-gapped installs and tests: points at an archive file. */
const EMBEDDING_MODEL_URL_ENV = 'SCREAM_CODE_EMBEDDING_MODEL_URL';

/** sha256 of the `model_optimized.onnx` payload inside the pinned package. */
export const EMBEDDING_MODEL_ONNX_SHA256 = '1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38';

export interface EnsureEmbeddingModelOptions {
  /** Archive source override (tests / self-hosted mirrors). Absolute URL. */
  readonly sourceUrl?: string;
  /** Expected sha256 of the extracted `model_optimized.onnx` (tests override). */
  readonly expectedOnnxSha256?: string;
  /** Byte-progress sink, throttled to ~10 callbacks per second. */
  readonly onProgress?: (received: number, total?: number) => void;
  /** Phase transitions the byte sink cannot express (currently: 'verify'). */
  readonly onPhase?: (phase: 'verify') => void;
  /** Abort the transfer when the caller no longer needs the payload. */
  readonly signal?: AbortSignal;
  /** Fail when no chunk arrives for this long (default 60s). */
  readonly idleTimeoutMs?: number;
  /** Fail when the whole transfer exceeds this (default 15min). */
  readonly totalTimeoutMs?: number;
}

/** Default stall guards: a trickling connection must not spin a spinner forever. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15 * 60_000;
/** Progress callback throttle: frequent enough to move, rare enough to be free. */
const PROGRESS_THROTTLE_MS = 100;

function modelDirPath(cacheDir: string): string {
  return join(cacheDir, BGESMALLZH_CACHE_NAME);
}

export function sha256File(filePath: string): Promise<string> {
  return readFile(filePath).then((data) => createHash('sha256').update(data).digest('hex'));
}

/**
 * Stage the embedding model files when they are missing: download the pinned
 * archive (HTTP status verified, unlike a naive downloader), extract,
 * and verify the weights payload against the pinned sha256.
 *
 * A partially extracted tree or a hash mismatch is removed so the caller keeps
 * the honest "weights missing" state the setup card is gated on — never a
 * directory that only looks installed.
 */
export async function ensureEmbeddingModelFiles(
  cacheDir: string,
  options?: EnsureEmbeddingModelOptions,
): Promise<void> {
  if (hasEmbeddingModelCache(cacheDir)) return;

  // Self-sufficient entry point: callers may hand us a not-yet-created dir.
  mkdirSync(cacheDir, { recursive: true });
  const modelDir = modelDirPath(cacheDir);
  // Staging name is ours alone: a stray `<name>.tar.gz` from older versions
  // never influences this downloader.
  const stagingPath = join(cacheDir, `${BGESMALLZH_CACHE_NAME}.tar.gz.part`);
  const url = options?.sourceUrl ?? process.env[EMBEDDING_MODEL_URL_ENV] ?? EMBEDDING_MODEL_SOURCE_URL;
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  // Abort plumbing: caller cancellation, stall detection and the overall cap all
  // funnel into one controller so cleanup below always sees a settled state.
  const controller = new AbortController();
  const onExternalAbort = (): void => { controller.abort(); };
  if (options?.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { controller.abort(); }, idleTimeoutMs);
  };
  const totalTimer = setTimeout(() => { controller.abort(); }, totalTimeoutMs);

  let received = 0;
  let announcedTotal: number | undefined;
  // Set only when the body was read to completion. Extraction and checksum
  // failures must surface with their own error instead of being rewritten into
  // a bogus "network timeout"; an aborted read never sets it, so the guards
  // below still own their own failure.
  let downloadCompleted = false;
  const announceProgress = (): void => {
    options?.onProgress?.(received, announcedTotal);
  };

  try {
    let response: Response;
    try {
      armIdleTimer();
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`fetch failed for ${url}: ${message}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`model source returned HTTP ${response.status} for ${url}`);
    }
    const contentLength = Number(response.headers.get('content-length'));
    announcedTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
    announceProgress();

    const body = response.body;
    if (body === null) {
      throw new Error(`model source returned an empty body for ${url}`);
    }
    const reader = body.getReader();
    // A reader whose stream ignores the abort signal would leave `read()`
    // pending forever; racing it against the abort keeps the stall guards in
    // charge of the loop regardless of how well-behaved the stream is.
    const abortRejection = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      controller.signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
    });
    const abortAwareRead = (): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }> =>
      Promise.race([reader.read(), abortRejection]);
    let handle: FileHandle;
    try {
      handle = await open(stagingPath, 'w');
    } catch (error) {
      // The stream must be released even when the local file cannot be opened.
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    let lastProgressAt = 0;
    try {
      await (async (): Promise<void> => {
        // Stream to disk: the archive is ~55MB and used to sit in memory in
        // full before extraction.
        for (;;) {
          let chunk: { done: true; value?: undefined } | { done: false; value: Uint8Array };
          try {
            chunk = await abortAwareRead();
          } catch (error) {
            // A stalled transfer surfaces here; report the stall honestly
            // instead of letting the read hang past the guard.
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message} (received ${received} of ${announcedTotal ?? '?'} bytes): ${url}`, { cause: error });
          }
          if (chunk.done) break;
          const bytes = chunk.value;
          armIdleTimer();
          await handle.write(bytes);
          received += bytes.byteLength;
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
            lastProgressAt = now;
            announceProgress();
          }
        }
        announceProgress();
        downloadCompleted = true;
      })();
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      await handle.close();
      // Release the underlying stream; best-effort because an aborted fetch
      // may already have torn it down.
      await reader.cancel().catch(() => undefined);
    }

    options?.onPhase?.('verify');
    await untar({ file: stagingPath, cwd: cacheDir });

    // Every required file must be present: a cache that only looks installed
    // (e.g. weights without tokenizer) would reload the setup card forever.
    for (const fileName of EMBEDDING_REQUIRED_FILES) {
      const target = join(modelDir, fileName);
      if (!existsSync(target) || statSync(target).size === 0) {
        throw new Error(`model package is missing ${fileName} after extraction: ${url}`);
      }
    }
    const weightsPath = join(modelDir, 'model_optimized.onnx');
    const sha256 = await sha256File(weightsPath);
    const expected = options?.expectedOnnxSha256 ?? EMBEDDING_MODEL_ONNX_SHA256;
    if (sha256 !== expected) {
      throw new Error(`model weights sha256 mismatch (${sha256.slice(0, 12)}… != ${expected.slice(0, 12)}…): ${url}`);
    }
  } catch (error: unknown) {
    // A partly extracted tree with no verified weights is worthless and would
    // keep the caller from retrying cleanly — remove it. Best effort: on
    // Windows a locked ONNX file can refuse deletion, and that failure must
    // not replace the real error.
    try {
      rmSync(modelDir, { recursive: true, force: true });
    } catch {
      // Keep the original error.
    }
    if (!downloadCompleted && controller.signal.aborted && !(options?.signal?.aborted ?? false)) {
      // Our own guard fired (stall or overall cap), not the caller. Expressed
      // with the words NETWORK_FAILURE recognises so callers can say "network".
      throw new Error(`model download timed out (received ${received} of ${announcedTotal ?? '?'} bytes): ${url}`, { cause: error });
    }
    throw error instanceof Error ? error : new Error(String(error), { cause: error });
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (options?.signal !== undefined) options.signal.removeEventListener('abort', onExternalAbort);
    rmSync(stagingPath, { force: true });
  }
}

/** Why a local embedding load failed, as far as the message can tell. */
export type EmbeddingFailureKind = 'install' | 'archive' | 'network' | 'other';

// The shapes these failures arrive in, verified against the real errors:
//   install  → "Cannot find package 'onnxruntime-web'" / tokenizer module
//              missing: the installation is incomplete (interrupted install,
//              pruned optional tree, broken node_modules) — reinstall fixes it
//   archive  → "TAR_BAD_ARCHIVE: Unrecognized archive format" from a staged
//              archive that is truncated or an HTML error page
//   network  → transport errors, our own stall/timeout guards ("model download
//              timed out"), and an HTTP status when the downloader reports one
//              instead of throwing a code
const INSTALL_FAILURE =
  /Cannot find (?:package|module) '(?:onnxruntime-web|@huggingface\/tokenizers)'|ERR_MODULE_NOT_FOUND|Failed to resolve module specifier/iu;
const ARCHIVE_FAILURE =
  /\bTAR_[A-Z_]+|incorrect header check|unexpected end of file|invalid tar|zlib|after extraction|sha256 mismatch/iu;
const NETWORK_FAILURE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket hang up|fetch failed)\b|network error|HTTP \d{3}|timed out|empty body/iu;

/**
 * Classify a load failure so callers can say something true about it: an
 * incomplete install, a corrupt cache, a network problem and anything else need
 * four different answers, and they used to be reported as one network problem.
 */
export function classifyEmbeddingFailure(message: string | undefined): EmbeddingFailureKind {
  if (message === undefined) return 'other';
  if (INSTALL_FAILURE.test(message)) return 'install';
  if (ARCHIVE_FAILURE.test(message)) return 'archive';
  if (NETWORK_FAILURE.test(message)) return 'network';
  return 'other';
}

/**
 * Loads both runtime packages — no model download — so callers can tell "this
 * installation cannot run the local model at all" apart from "the download
 * failed". The runtime is JavaScript plus WebAssembly, so a failure here is an
 * incomplete installation rather than an unsupported platform.
 */
export async function probeLocalEmbeddingSupport(): Promise<{ supported: boolean; error?: string }> {
  try {
    await import('onnxruntime-web');
    await import('@huggingface/tokenizers');
    return { supported: true };
  } catch (error: unknown) {
    return { supported: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove every trace of a previous BGESmallZH download: the extracted model
 * directory and the legacy staged archive name.
 *
 * The legacy `<name>.tar.gz` file is still swept because older versions staged
 * the archive under that name; leaving it behind would waste 55MB per doomed
 * attempt. Our own downloader stages `.tar.gz.part` and always removes it.
 *
 * Never throws: a file locked by another process (on Windows a mapped ONNX file
 * stays locked) must not replace the download error the caller is reporting.
 */
export function clearEmbeddingModelCache(cacheDir: string): void {
  for (const name of [BGESMALLZH_CACHE_NAME, `${BGESMALLZH_CACHE_NAME}.tar.gz`]) {
    const target = join(cacheDir, name);
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // The next attempt retries the wipe; the caller keeps its own error.
    }
  }
}

/**
 * True when every file the runtime needs is already on disk. Loading then never
 * downloads, so callers can safely trigger a local load without risking a
 * surprise mid-query download. All required files are checked (not just the
 * weights): a partially restored cache must count as missing so the setup flow
 * repairs it instead of failing at load time.
 */
export function hasEmbeddingModelCache(cacheDir: string): boolean {
  const modelDir = modelDirPath(cacheDir);
  if (!existsSync(modelDir)) return false;
  return EMBEDDING_REQUIRED_FILES.every((fileName) => {
    const target = join(modelDir, fileName);
    return existsSync(target) && statSync(target).size > 0;
  });
}
