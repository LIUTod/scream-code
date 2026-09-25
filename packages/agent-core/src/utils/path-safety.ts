/**
 * Cross-platform path classification for call sites that must decide whether
 * a path is absolute and whether it sits inside a directory.
 *
 * The paths reaching these helpers need not match the host OS: a
 * Windows-shaped path can arrive at a macOS/Linux process (a config value, a
 * remote workspace, a session recorded on another machine). `node:path`
 * derives absoluteness from `process.platform`, so `C:\x` and
 * `\\server\share` silently read as ordinary relative names there and get
 * appended under a directory the caller never intended. These helpers instead
 * classify every supported flavour explicitly — POSIX (`/x`, `\x`), Windows
 * drive (`C:\x`, `C:/x`, drive-relative `C:x`) and UNC
 * (`\\server\share`) — on top of `pathe`, the path library the rest of this
 * package uses.
 */

import { isAbsolute, join, normalize } from 'pathe';

/** `C:`, `C:\x`, `C:/x`, and the drive-relative `C:x`. */
const WINDOWS_DRIVE = /^[A-Za-z]:/;
/** `\\server\share` and `//server/share`. */
const WINDOWS_UNC = /^[/\\]{2}[^/\\]/;

/** True when `path` is written in Windows syntax (drive-qualified or UNC). */
function usesWindowsSyntax(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || WINDOWS_UNC.test(path);
}

/**
 * Normalize a candidate that declares its own root.
 *
 * `//x` is UNC syntax only next to a Windows `base`: a POSIX caller passing
 * `//work/file.ts` means the POSIX path `/work/file.ts`, and comparing the
 * doubled slash as written would place a file inside the working directory
 * outside it. The Windows `\\server\share` spelling is left alone — it is UNC
 * in every context, and folding it into the POSIX namespace would widen the
 * check instead of narrowing it.
 */
function normalizeRootedCandidate(candidate: string, baseIsWindows: boolean): string {
  if (!baseIsWindows && candidate.startsWith('//')) {
    return normalize(candidate.replace(/^\/+/, '/'));
  }
  return normalize(candidate);
}

/**
 * True when `path` names its own root instead of one relative to a base:
 * POSIX-absolute (`/x`, `\x`), UNC-rooted, or drive-qualified. `isAbsolute`
 * covers the first three; the drive test adds `C:x`, which is relative to
 * *the drive's* current directory and therefore equally unappendable under a
 * base.
 */
function declaresOwnRoot(path: string): boolean {
  return isAbsolute(path) || WINDOWS_DRIVE.test(path);
}

/**
 * True when `candidate` is `base` itself or a descendant of it.
 *
 * A relative `candidate` is resolved against `base`; one that declares its
 * own root is compared as written, so `C:\outside\f.txt` is outside a POSIX
 * `base` on every host. Comparison is made on path components (`/work-evil`
 * is not inside `/work`) and case-insensitively when both sides use Windows
 * syntax, because Windows filenames are case-insensitive.
 */
export function isPathInside(base: string, candidate: string): boolean {
  const basePath = normalize(base);
  const baseIsWindows = usesWindowsSyntax(basePath);
  const candidatePath = declaresOwnRoot(candidate)
    ? normalizeRootedCandidate(candidate, baseIsWindows)
    : join(basePath, candidate);
  const foldCase = baseIsWindows && usesWindowsSyntax(candidatePath);
  const lhs = foldCase ? basePath.toLowerCase() : basePath;
  const rhs = foldCase ? candidatePath.toLowerCase() : candidatePath;
  if (lhs === rhs) return true;
  return rhs.startsWith(lhs.endsWith('/') ? lhs : `${lhs}/`);
}

/**
 * True when `candidate` may be appended under a directory: it declares no
 * root of its own and does not climb out of the directory it is appended to.
 *
 * The check is lexical and runs on the normalized form, so `a/../b.txt` is
 * accepted while `../b.txt`, `a/../../x` and `sub/..` are rejected. Only
 * `..` path *components* are unsafe — `..foo.txt` is an ordinary file name.
 */
export function isSafeRelativePath(candidate: string): boolean {
  if (candidate.trim().length === 0) return false;
  if (declaresOwnRoot(candidate)) return false;
  const normalized = normalize(candidate);
  if (normalized === '.' || normalized === '..') return false;
  return !normalized.startsWith('../');
}
