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
import {
  diagnosticsSignatures,
  type EditRecoveryQueue,
  type EditRecoveryReminder,
} from '../../support/edit-recovery-queue';

export const DIAGNOSTICS_TIMEOUT_MS = 1500;
const MAX_DIAGNOSTICS_LINES = 8;

/** Empty observation set: nothing is reported, so every reminder is resolved. */
const NO_SIGNATURES: ReadonlySet<string> = new Set();

export type DiagnosticsUnavailableReason =
  /** Registry absent, file type unsupported, or client could not be obtained. */
  | 'unsupported'
  /** The language server binary could not be started (likely not installed). */
  | 'server-missing';

export interface DiagnosticsResult {
  readonly available: boolean;
  /**
   * True when the server PUBLISHED diagnostics for the file. False means the
   * empty `diagnostics` list carries no information — the fetch timed out, the
   * client threw, or the server is unavailable — and callers must not read it
   * as "the file is clean".
   */
  readonly observed: boolean;
  readonly diagnostics: readonly LspDiagnostic[];
  /** True when any diagnostic has severity 1 (Error). Callers use this to flag the tool result as isError. */
  readonly hasErrors: boolean;
  readonly reason?: DiagnosticsUnavailableReason;
  /** The server command name, when known — used to build the install hint. */
  readonly serverCommand?: string;
}

/** Returns true when any diagnostic is severity 1 (Error) per LSP spec. */
export function hasErrors(diagnostics: readonly LspDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 1);
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
    return { available: false, observed: false, diagnostics: [], hasErrors: false, reason: 'unsupported' };
  }
  const languageId = registry.languageIdForPath(path);
  if (languageId === undefined) {
    return { available: false, observed: false, diagnostics: [], hasErrors: false, reason: 'unsupported' };
  }
  const serverCommand = registry.commandForPath(path)?.[0];
  let client;
  try {
    client = await registry.getClient(path, workspaceRoot);
  } catch {
    return {
      available: false,
      observed: false,
      diagnostics: [],
      hasErrors: false,
      reason: 'server-missing',
      serverCommand,
    };
  }
  if (client === undefined) {
    return { available: false, observed: false, diagnostics: [], hasErrors: false, reason: 'unsupported' };
  }
  try {
    const content = await jian.readText(path);
    client.didOpen(path, content, languageId);
    const report = await client.diagnosticsReport(path, DIAGNOSTICS_TIMEOUT_MS);
    return {
      available: true,
      observed: report.observed,
      diagnostics: report.diagnostics,
      hasErrors: hasErrors(report.diagnostics),
    };
  } catch {
    // The fetch itself failed: the empty list is "nothing observed", not a
    // clean file.
    return { available: true, observed: false, diagnostics: [], hasErrors: false };
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

/**
 * Fold a post-write observation into the session reminder queue.
 *
 * Edit maintains the queue itself (it diffs each observation against the
 * file's last-seen errors to find the ones it introduced). A fix that lands
 * through a tool that bypasses Edit — Write, an ast_edit apply — still
 * produces the only observation that path gets, so without this the reminder
 * would stay pending forever. Only clearing happens here: these writes have
 * no baseline, so they never introduce reminders.
 *
 * Cheap by construction: an empty queue returns before any I/O, and only
 * paths with a pending reminder are touched. A reminder whose file no longer
 * exists is cleared outright — nothing will publish diagnostics for a deleted
 * file again. An unobserved fetch (`result.observed === false`) changes
 * nothing, mirroring how an unavailable server is treated.
 */
export async function reconcileEditReminders(
  queue: EditRecoveryQueue | undefined,
  jian: Jian,
  path: string,
  result: DiagnosticsResult,
): Promise<void> {
  if (queue === undefined) return;
  const pending = queue.drain();
  if (pending.length === 0) return;
  await clearDeletedReminders(queue, jian, pending);
  if (!result.observed) return;
  const current = new Set(
    diagnosticsSignatures(result.diagnostics).map((signature) => signature.signature),
  );
  queue.clearIfResolved(path, current);
}

/**
 * Drop the reminders whose file is gone. Only a definitive ENOENT counts: any
 * other stat failure leaves the file's state unknown, and clearing on an
 * unreadable path would hide a live error.
 */
async function clearDeletedReminders(
  queue: EditRecoveryQueue,
  jian: Jian,
  pending: readonly EditRecoveryReminder[],
): Promise<void> {
  for (const reminderPath of new Set(pending.map((reminder) => reminder.path))) {
    if (await pathExists(jian, reminderPath)) continue;
    queue.clearIfResolved(reminderPath, NO_SIGNATURES);
  }
}

async function pathExists(jian: Jian, path: string): Promise<boolean> {
  try {
    await jian.stat(path, { followSymlinks: false });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT';
  }
}
