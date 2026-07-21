// Adapted from oh-my-pi's utils/markit.ts (MIT). Lazy entry point for the
// markit document engine: keeps mammoth/mupdf off the startup import graph,
// installs a quiet stdout hook for the mupdf WASM module, and routes every
// conversion through the filesystem cache.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { log } from '#/logging/logger';
import type { ConversionResult, Markit, StreamInfo } from '../markit';
import { abortError } from './abort';
import {
  type MarkitConversionCacheStatus,
  markitConversionCacheKey,
  readMarkitConversionCache,
  writeMarkitConversionCache,
} from './markit-cache';

export interface MarkitConversionResult {
  content: string;
  ok: boolean;
  error?: string;
  cache?: MarkitConversionCacheStatus;
}

interface MuPdfWasmModuleConfig {
  print?: (...values: unknown[]) => void;
  printErr?: (...values: unknown[]) => void;
}

function logMuPdfWasmOutput(stream: 'stdout' | 'stderr', values: unknown[]): void {
  const message =
    values.length === 1 && typeof values[0] === 'string' ? values[0] : values.map(String).join(' ');
  log.debug('mupdf wasm output', { stream, message });
}

// `$libmupdf_wasm_Module` is declared globally (as `any`) by the mupdf package.
// Install print hooks before the WASM module initializes so its stdout/stderr
// route to the file logger instead of corrupting the TUI.
function installMuPdfWasmLogger(): void {
  const globalScope = globalThis as { $libmupdf_wasm_Module?: MuPdfWasmModuleConfig };
  const moduleConfig: MuPdfWasmModuleConfig = globalScope.$libmupdf_wasm_Module ?? {};
  moduleConfig.print = (...values: unknown[]) => logMuPdfWasmOutput('stdout', values);
  moduleConfig.printErr = (...values: unknown[]) => logMuPdfWasmOutput('stderr', values);
  globalScope.$libmupdf_wasm_Module = moduleConfig;
}

installMuPdfWasmLogger();

let markit: () => Markit | Promise<Markit> = async () => {
  // Lazy: the document engine (mammoth/mupdf) loads only when a document is
  // first converted.
  const promise = import('../markit').then(({ Markit }) => {
    const instance = new Markit();
    markit = () => instance;
    return instance;
  });
  markit = () => promise;
  return promise;
};

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) return '.bin';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return 'Conversion failed';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function untilAborted<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  if (signal === undefined) return task();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

async function runMarkitConversion<T>(
  task: (markit: Markit) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const instance = await markit();
    return await untilAborted(signal, () => task(instance));
  } catch (error) {
    if (isAbort(error)) {
      throw abortError();
    }
    throw error;
  }
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
  if (typeof markdown === 'string' && markdown.length > 0) {
    return { content: markdown, ok: true };
  }
  return { content: '', ok: false, error: 'Conversion produced no output' };
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function runCachedBufferConversion(
  bytes: Uint8Array,
  streamInfo: StreamInfo,
  signal?: AbortSignal,
  cacheEnabled = true,
): Promise<MarkitConversionResult> {
  const cacheKey = cacheEnabled
    ? markitConversionCacheKey(bytes, streamInfo.extension ?? streamInfo.mimetype ?? '.bin')
    : undefined;

  if (cacheKey !== undefined) {
    throwIfAborted(signal);
    const cached = await readMarkitConversionCache(cacheKey);
    throwIfAborted(signal);
    if (cached.status === 'hit') {
      return { content: cached.content, ok: true, cache: 'hit' };
    }
  }

  throwIfAborted(signal);
  let result: ConversionResult;
  try {
    result = await runMarkitConversion(
      (markitInstance) => markitInstance.convert(toBuffer(bytes), streamInfo),
      signal,
    );
  } catch (error) {
    if (isAbort(error)) {
      throw abortError();
    }
    return { content: '', ok: false, error: normalizeError(error), cache: cacheEnabled ? 'miss' : 'skipped' };
  }

  const finalized = finalizeConversion(result.markdown);
  if (finalized.ok && cacheKey !== undefined) {
    await writeMarkitConversionCache(cacheKey, finalized.content);
  }
  return { ...finalized, cache: cacheEnabled ? 'miss' : 'skipped' };
}

export async function convertFileWithMarkit(
  filePath: string,
  signal?: AbortSignal,
  options?: { imageDir?: string },
): Promise<MarkitConversionResult> {
  if (options?.imageDir !== undefined) {
    // Image extraction writes files into imageDir as a side effect; a
    // markdown-only cache hit would leave the directory missing members, so
    // this path stays uncached.
    try {
      const result = await runMarkitConversion(
        (markitInstance) => markitInstance.convertFile(filePath, { imageDir: options.imageDir }),
        signal,
      );
      return { ...finalizeConversion(result.markdown), cache: 'skipped' };
    } catch (error) {
      if (isAbort(error)) {
        throw abortError();
      }
      return { content: '', ok: false, error: normalizeError(error), cache: 'skipped' };
    }
  }

  throwIfAborted(signal);
  let bytes: Uint8Array;
  try {
    bytes = await untilAborted(signal, () => fs.readFile(filePath));
  } catch (error) {
    if (isAbort(error)) throw abortError();
    return { content: '', ok: false, error: normalizeError(error), cache: 'miss' };
  }
  const streamInfo: StreamInfo = {
    localPath: filePath,
    extension: path.extname(filePath).toLowerCase(),
    filename: path.basename(filePath),
  };
  return runCachedBufferConversion(bytes, streamInfo, signal, true);
}

export async function convertBufferWithMarkit(
  buffer: Uint8Array,
  extension: string,
  signal?: AbortSignal,
  options?: { useCache?: boolean },
): Promise<MarkitConversionResult> {
  const normalizedExtension = normalizeExtension(extension);
  const streamInfo: StreamInfo = {
    extension: normalizedExtension,
    filename: `input${normalizedExtension}`,
  };
  return runCachedBufferConversion(buffer, streamInfo, signal, options?.useCache ?? true);
}
