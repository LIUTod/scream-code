import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'pathe';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ExportSessionManifest } from '#/rpc/core-api';
import { ZipFile } from 'yazl';

export async function collectFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export type ExtraZipEntry =
  | {
      /** Absolute path on disk. */
      readonly source: string;
      /** zip-relative target path. */
      readonly target: string;
    }
  | {
      readonly data: Buffer;
      /** zip-relative target path. */
      readonly target: string;
    };

export async function writeExportZip(args: {
  readonly outputPath: string;
  readonly manifest: ExportSessionManifest;
  readonly sessionDir: string;
  readonly sessionFiles: readonly string[];
  readonly extraEntries?: readonly ExtraZipEntry[];
}): Promise<readonly string[]> {
  await mkdir(dirname(args.outputPath), { recursive: true });

  const entries: string[] = ['manifest.json'];
  const zip = new ZipFile();
  // yazl reports failures (a source that vanished, a read error, a byte-count
  // mismatch) as out-of-band `error` events on the ZipFile rather than through
  // `outputStream`. Unhandled they abort the process instead of failing the
  // export, and the pipeline would then wait forever for an archive that can
  // never finish — so the first one is captured and raced against the write.
  const zipFailure = new Promise<never>((_resolve, reject) => {
    zip.once('error', reject);
  });
  zip.addBuffer(Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf-8'), 'manifest.json');

  for (const abs of args.sessionFiles) {
    const rel = relative(args.sessionDir, abs).split(/[\\/]/).join('/');
    addStreamedFile(zip, abs, rel);
    entries.push(rel);
  }

  for (const extra of args.extraEntries ?? []) {
    if ('data' in extra) {
      zip.addBuffer(extra.data, extra.target);
      entries.push(extra.target);
      continue;
    }
    // The entry is opt-in, so a missing source stays non-fatal: it is probed
    // before the archive is asked to read it (the read itself is lazy).
    try {
      const stats = await stat(extra.source);
      if (!stats.isFile()) continue;
    } catch {
      continue;
    }
    addStreamedFile(zip, extra.source, extra.target);
    entries.push(extra.target);
  }

  try {
    zip.end();
    await Promise.race([
      pipeline(zip.outputStream as unknown as Readable, createWriteStream(args.outputPath)),
      zipFailure,
    ]);
  } catch (error) {
    // A half-written archive is worse than none: drop it before reporting, and
    // never mask the original failure with a cleanup error.
    await rm(args.outputPath, { force: true }).catch(() => {});
    throw error;
  }
  return entries;
}

/**
 * Add a file as a lazily-streamed zip entry.
 *
 * `ZipFile.addFile` records the size from a stat and then asserts the byte count
 * while reading, so exporting a session that is still appending to its wire or
 * log files — or that rotates them mid-export — would abort the whole export.
 * Reading lazily without a declared size keeps the entry tolerant of growth,
 * opens one file at a time, and still never holds the file in memory.
 * (`addReadStreamLazy` is the entry point yazl's own `addFile` uses; the
 * published typings just do not declare it.)
 */
function addStreamedFile(zip: ZipFile, source: string, target: string): void {
  const lazyZip = zip as unknown as {
    addReadStreamLazy(
      metadataPath: string,
      getReadStream: (callback: (error: Error | null, stream: Readable) => void) => void,
    ): void;
  };
  lazyZip.addReadStreamLazy(target, (callback) => {
    const stream = createReadStream(source);
    // yazl wires error handling only for streams it opens itself (`addFile`),
    // so a caller-supplied stream has to route failures back to the archive.
    stream.on('error', (error: Error) => zip.emit('error', error));
    callback(null, stream);
  });
}
