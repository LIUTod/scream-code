/**
 * Collect the files a single assistant turn actually wrote.
 *
 * Every entry derives from a successful write/edit-family tool call (a result
 * arrived and it did not error) — never from the reply text. A path the
 * assistant merely mentions in prose is not evidence that any file was
 * touched, so message content is never scanned; the tool call is the record
 * of what happened.
 */
import type { ChatMessage } from '../types';
import { isEditTool, toolStatus } from './toolGroup';

export interface WrittenFile {
  /** Resolved path of a file this turn wrote. */
  filePath: string;
  /** Tool that performed the write (e.g. `Write` / `Edit`). */
  toolName: string;
}

/** Read the target path from a tool call's args (`file_path` wins over `path`). */
function readToolPath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const obj = args as Record<string, unknown>;
  const value = obj['file_path'] ?? obj['path'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Resolve a tool path against the session cwd: absolute and `~` paths pass
 * through untouched; relative paths drop leading `./` segments and are joined
 * onto cwd. Without a cwd the (cleaned) relative path is kept as-is.
 */
export function resolveWrittenPath(raw: string, cwd?: string): string {
  if (raw.startsWith('/') || raw.startsWith('~')) return raw;
  let rel = raw;
  while (rel.startsWith('./')) rel = rel.slice(2);
  if (!cwd) return rel;
  return `${cwd.replace(/\/+$/, '')}/${rel}`;
}

/**
 * Distinct files written by one turn, in first-seen order. Success means the
 * call settled with a result and no error (`toolStatus` with live=false:
 * pending/errored/suspended calls never qualify), so the list stays stable
 * while a turn is still streaming — entries appear once, no flicker.
 */
export function extractTurnWrittenFiles(message: ChatMessage, cwd?: string): WrittenFile[] {
  const seen = new Set<string>();
  const written: WrittenFile[] = [];
  for (const tool of message.tools) {
    if (!isEditTool(tool.name)) continue;
    if (toolStatus(tool, false) !== 'ok') continue;
    const raw = readToolPath(tool.args);
    if (!raw) continue;
    const filePath = resolveWrittenPath(raw, cwd);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    written.push({ filePath, toolName: tool.name });
  }
  return written;
}
