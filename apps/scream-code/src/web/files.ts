import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** File-access error carrying an HTTP status code for REST handlers. */
export class FileAccessError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
  encoding: 'utf-8';
}

export const MAX_FILE_READ = 256 * 1024;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'target']);

/**
 * Read-only filesystem gate for the web UI.
 *
 * Design (roots + realpath containment model, simplified):
 * - a dynamic roots set (all session workDirs ∪ current workDir) bounds every access;
 * - lexical containment check resolves the candidate inside a root FIRST;
 * - then realpath() is compared against the realpath of the root so symlinks
 *   cannot escape the boundary;
 * - every operation is read-only: no create/write/delete is exposed.
 */
export class FileGate {
  constructor(private readonly roots: () => string[]) {}

  /** Current allowed roots (session workdirs) — used by the REST /files/root route. */
  public getRoots(): string[] {
    return this.roots();
  }

  /** Resolve a client-supplied path against the gate. Throws 403/404 on violation. */
  async resolve(candidate: string): Promise<string> {
    const roots = this.roots().filter(Boolean);
    if (roots.length === 0) throw new FileAccessError(409, '没有可访问的目录（尚无会话）');

    const normalized = candidate.replaceAll('\\', '/');
    const absCandidate = resolve(isAbsolute(normalized) ? normalized : join(resolve(roots[0]!), normalized));

    for (const root of roots) {
      const rootLex = resolve(root);
      // Lexical containment: candidate must be inside the ROOT's lexical path
      // (no ../ escapes). Roots themselves may live under symlinked prefixes
      // (e.g. macOS /var → /private/var), so both sides must be normalized.
      const relLex = relative(rootLex, absCandidate);
      if (relLex === '' || (!relLex.startsWith('..') && !isAbsolute(relLex))) {
        // realpath containment: a symlink inside the root must not resolve
        // to a location outside the root's own realpath.
        const candidateReal = await this.tryRealpath(absCandidate);
        if (!candidateReal) throw new FileAccessError(404, `文件不存在：${candidate}`);
        const rootReal = (await this.tryRealpath(rootLex)) ?? rootLex;
        const relReal = relative(rootReal, candidateReal);
        if (relReal === '' || (!relReal.startsWith('..') && !isAbsolute(relReal))) {
          return absCandidate;
        }
      }
    }
    throw new FileAccessError(403, '目录或路径不属于任何会话工作目录');
  }

  private async tryRealpath(p: string): Promise<string | null> {
    try {
      return await realpath(p);
    } catch {
      return null;
    }
  }

  async list(candidate: string): Promise<FileEntry[]> {
    const abs = await this.resolve(candidate);
    let entries: Dirent[] = [];
    try {
      entries = await readdir(abs, { withFileTypes: true }) as unknown as Dirent[];
    } catch (error) {
      throw new FileAccessError(404, `无法读取目录：${candidate}`);
    }

    const out: FileEntry[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(abs, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          // Only symlinks resolving to an in-boundary file are exposed.
          const real = await this.resolve(full);
          const st = await stat(real);
          out.push({ name: entry.name, path: full, type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs });
        } else if (entry.isDirectory()) {
          const st = await stat(full);
          out.push({ name: entry.name, path: full, type: 'dir', size: 0, mtime: st.mtimeMs });
        } else if (entry.isFile()) {
          const st = await stat(full);
          out.push({ name: entry.name, path: full, type: 'file', size: st.size, mtime: st.mtimeMs });
        }
      } catch {
        // Skip entries that fail the gate (symlinks escaping the boundary).
      }
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return out;
  }

  async read(candidate: string): Promise<FileReadResult> {
    const abs = await this.resolve(candidate);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new FileAccessError(404, `文件不存在：${candidate}`);
    if (st.isDirectory()) throw new FileAccessError(400, `是目录：${candidate}`);
    if (st.size > MAX_FILE_READ) {
      const buf = await readFile(abs, { encoding: 'utf-8' });
      return { path: abs, content: buf.slice(0, MAX_FILE_READ), truncated: true, encoding: 'utf-8' };
    }
    const content = await readFile(abs, { encoding: 'utf-8' });
    return { path: abs, content, truncated: false, encoding: 'utf-8' };
  }

  /** Mime type guess used by the raw/preview endpoint. */
  contentType(candidate: string): string {
    const ext = basename(candidate).split('.').pop()?.toLowerCase() ?? '';
    const TABLE: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
      pdf: 'application/pdf',
      md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
      json: 'application/json; charset=utf-8', yml: 'text/yaml; charset=utf-8', yaml: 'text/yaml; charset=utf-8',
      csv: 'text/csv; charset=utf-8', log: 'text/plain; charset=utf-8',
      ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8',
      jsx: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8',
      go: 'text/plain; charset=utf-8', java: 'text/plain; charset=utf-8', c: 'text/plain; charset=utf-8',
      h: 'text/plain; charset=utf-8', cpp: 'text/plain; charset=utf-8', hpp: 'text/plain; charset=utf-8',
      sh: 'text/plain; charset=utf-8', bash: 'text/plain; charset=utf-8', zsh: 'text/plain; charset=utf-8',
      css: 'text/plain; charset=utf-8', html: 'text/plain; charset=utf-8', vue: 'text/plain; charset=utf-8',
      toml: 'text/plain; charset=utf-8', lock: 'text/plain; charset=utf-8', env: 'text/plain; charset=utf-8',
      patch: 'text/plain; charset=utf-8', diff: 'text/plain; charset=utf-8',
    };
    return TABLE[ext] ?? 'application/octet-stream';
  }

  /** MIME for read-only raw preview; returns null when the type is not inherently printable. */
  previewKind(candidate: string): 'image' | 'audio' | 'pdf' | 'text' | null {
    const ct = this.contentType(candidate);
    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('audio/')) return 'audio';
    if (ct === 'application/pdf') return 'pdf';
    if (ct.startsWith('text/')) return 'text';
    return null;
  }

  /** Directory of a resolved path, used for the breadcrumb. */
  dirOf(absPath: string): string {
    return dirname(absPath);
  }

  /** Path-friendly display name for the breadcrumb. */
  nameOf(absPath: string): string {
    return basename(absPath);
  }
}
