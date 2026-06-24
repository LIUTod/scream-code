/**
 * Post-edit LSP diagnostics.
 *
 * After Edit/Write modifies a file, this fetches current diagnostics from the
 * relevant language server and formats them for appending to the tool output.
 * The model sees syntax/type errors in the same turn and can self-correct
 * without a separate `LSP diagnostics` tool call.
 *
 * Synchronous with a short timeout (default 1.5s): the tool blocks until
 * diagnostics arrive or the timeout expires. LSP servers typically respond
 * within 100-500ms, so the perceived latency is small.
 *
 * Failure modes are surfaced to the caller via `reason` so Edit/Write can
 * append a friendly install hint when a supported language's server is
 * missing — instead of silently degrading and hiding that the feature exists.
 */

import type { Jian } from '@scream-code/jian';

import type { LspRegistry } from '../../../lsp/registry';
import { formatDiagnostic, type LspDiagnostic } from '../../../lsp/client';

export const DIAGNOSTICS_TIMEOUT_MS = 1500;
const MAX_DIAGNOSTICS_LINES = 8;

export type DiagnosticsUnavailableReason =
  /** Registry absent, file type unsupported, or client could not be obtained. */
  | 'unsupported'
  /** The language server binary could not be started (likely not installed). */
  | 'server-missing';

export interface DiagnosticsResult {
  readonly available: boolean;
  readonly diagnostics: readonly LspDiagnostic[];
  readonly reason?: DiagnosticsUnavailableReason;
  /** The server command name, when known — used to build the install hint. */
  readonly serverCommand?: string;
}

/**
 * Fetch diagnostics for a file after it has been edited. Reads the current
 * file content, notifies the LSP server (didOpen for first open, didChange
 * internally for subsequent edits), then polls for published diagnostics.
 *
 * Never throws — LSP failures are swallowed so Edit/Write always succeed.
 * When the LSP is unavailable, `reason` distinguishes unsupported file types
 * from a missing language server binary so the caller can decide whether to
 * surface an install hint.
 */
export async function fetchDiagnostics(
  registry: LspRegistry | undefined,
  jian: Jian,
  path: string,
  workspaceRoot: string,
): Promise<DiagnosticsResult> {
  if (registry === undefined) {
    return { available: false, diagnostics: [], reason: 'unsupported' };
  }
  const languageId = registry.languageIdForPath(path);
  if (languageId === undefined) {
    return { available: false, diagnostics: [], reason: 'unsupported' };
  }
  const serverCommand = registry.commandForPath(path)?.[0];
  let client;
  try {
    client = await registry.getClient(path, workspaceRoot);
  } catch {
    return {
      available: false,
      diagnostics: [],
      reason: 'server-missing',
      serverCommand,
    };
  }
  if (client === undefined) {
    return { available: false, diagnostics: [], reason: 'unsupported' };
  }
  try {
    const content = await jian.readText(path);
    client.didOpen(path, content, languageId);
    const diags = await client.diagnostics(path, DIAGNOSTICS_TIMEOUT_MS);
    return { available: true, diagnostics: diags };
  } catch {
    return { available: true, diagnostics: [] };
  }
}

/**
 * Format diagnostics as text to append to tool output. Returns an empty
 * string when no diagnostics were reported, so callers can unconditionally
 * append without a guard.
 */
export function formatDiagnosticsNotice(result: DiagnosticsResult): string {
  if (!result.available || result.diagnostics.length === 0) return '';
  const shown = result.diagnostics.slice(0, MAX_DIAGNOSTICS_LINES);
  const lines = shown.map((d) => formatDiagnostic(d));
  const remaining = result.diagnostics.length - MAX_DIAGNOSTICS_LINES;
  const header = `[LSP] ${String(result.diagnostics.length)} diagnostic(s):`;
  const tail = remaining > 0 ? `\n… (${String(remaining)} more)` : '';
  return `${header}\n${lines.join('\n')}${tail}`;
}

/**
 * Build a friendly hint shown after Edit/Write when the language server is
 * missing for a supported file type. Returns an empty string for unsupported
 * file types (no point suggesting a server that wouldn't apply) and when the
 * server did start successfully.
 */
export function formatDiagnosticsHint(result: DiagnosticsResult): string {
  if (result.reason !== 'server-missing') return '';
  const cmd = result.serverCommand;
  if (cmd === undefined) return '';
  return `\n提示：为获得编辑后的类型与语法诊断，建议安装语言服务器 \`${cmd}\`。`;
}
