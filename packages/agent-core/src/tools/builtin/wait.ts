/**
 * WaitTool — block the current turn until a background task finishes.
 *
 * The blocking counterpart to `TaskOutput`: instead of polling the task
 * registry, the call parks until the target task reaches a terminal state
 * (completed / failed / killed / lost — the manager's own status strings),
 * then returns that status, a bounded output tail, and how many other
 * owned tasks are still running.
 *
 * Blocking mechanics:
 *
 *   - Event-driven path (primary): one `onLifecycle` subscription per tool
 *     instance fans terminal events out to every call currently blocked in
 *     `execute`. The subscription is registered ONCE in the constructor —
 *     `onLifecycle` has no unsubscribe, so a per-call subscription would
 *     leak a closure into the manager on every Wait. A blocked call only
 *     registers a small deliver closure in `activeWaits`, removed on settle.
 *   - Ladder poll (fallback): the task registry is re-checked on an idle
 *     ladder (`WAIT_LADDER_MS`, then every `WAIT_LADDER_IDLE_MS`) so a
 *     terminal state missed by the event path is still observed. The ladder
 *     never fires before the first second, so a normal event-driven settle
 *     costs no polling.
 *   - `timeout_seconds` caps the whole block. Timing out is NOT an error:
 *     the result reports `status: running` and lets the model decide
 *     whether to wait again or check `TaskOutput`.
 *
 * The tool deliberately does NOT call `settlePendingExits` before its
 * initial registry check (TaskOutput does): that helper leaves its settle-
 * grace `setTimeout` pending whenever a just-exited task is present, and
 * the event path plus the ladder observe the same settle within its 10 ms
 * window anyway, so skipping it keeps every Wait timer accounted for.
 *
 * An abort (user interrupt / parent-agent interject) cancels the wait. The
 * result mirrors the Bash / Python interrupt convention: an error result
 * carrying the attribution, which the loop tags `code: 'aborted'` so the
 * consecutive-failure breaker does not charge the interruption to the model.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../loop/types';
import { isParentInterject } from '../../utils/abort';
import {
  isBackgroundTaskTerminal,
  type BackgroundProcessManager,
  type BackgroundTaskInfo,
} from '../background/manager';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import WAIT_DESCRIPTION from './wait.md';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TAIL_LINES = 40;
const MAX_TAIL_LINES = 200;

/**
 * Inline tail budget in bytes. Scaled down for small `tail_lines` requests,
 * capped at TaskOutput's inline preview norm so a Wait result never carries
 * more output text than a TaskOutput snapshot would. The full log stays on
 * disk (`output_path`) and is read via the `Read` tool.
 */
const TAIL_PREVIEW_BYTE_CAP = 32 * 1024;
const TAIL_BYTES_PER_LINE = 2048;

/**
 * Idle ladder for the registry-recheck fallback: escalating delays keep the
 * miss window tight early on and settle into a cheap cadence afterwards.
 * The event-driven path is primary; this ladder only exists for terminal
 * states the lifecycle subscription missed.
 */
const WAIT_LADDER_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];
const WAIT_LADDER_IDLE_MS = 15_000;

// ── Input schema ─────────────────────────────────────────────────────

export const WaitInputSchema = z.object({
  task_id: z
    .string()
    .describe(
      'Background task ID to wait for. Omit to wait for whichever task of this session finishes first.',
    )
    .optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS, { message: `timeout_seconds cannot exceed ${MAX_TIMEOUT_SECONDS} (10 minutes).` })
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe('Maximum seconds to block. On timeout the task is still running and the result is not an error.')
    .optional(),
  tail_lines: z
    .number()
    .int()
    .min(1)
    .max(MAX_TAIL_LINES, { message: `tail_lines cannot exceed ${MAX_TAIL_LINES}.` })
    .default(DEFAULT_TAIL_LINES)
    .describe('Trailing output lines included with the result.')
    .optional(),
});

export type WaitInput = z.Infer<typeof WaitInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

/** How a blocked wait settled. `terminal` carries the winning task's info. */
type WaitOutcome =
  | { readonly kind: 'terminal'; readonly info: BackgroundTaskInfo }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/** Who fired the abort that settled an interrupted Wait. Same attribution the Bash tool reports. */
function interruptedBy(signal: AbortSignal): 'user' | 'the parent agent' {
  return isParentInterject(signal.reason) ? 'the parent agent' : 'user';
}

/**
 * Extract the last `maxLines` lines of a byte-tail preview. A trailing
 * newline splits into an empty final element that the log never had — drop
 * exactly that one artifact, keep any real blank lines above it.
 */
function tailFromPreview(preview: string, maxLines: number): string {
  if (preview.length === 0) return '';
  const lines = preview.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-maxLines).join('\n');
}

export class WaitTool implements BuiltinTool<WaitInput> {
  readonly name = 'Wait' as const;
  readonly description: string = WAIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WaitInputSchema);
  // Blocking waits up to 600s; the tool manages its own wait budget and
  // honours the turn's abort signal.
  readonly longRunning = true;

  /**
   * Deliver closures of the calls currently blocked in `execute`. The single
   * constructor subscription fans terminal events out to all of them, so a
   * Wait adds nothing to the manager's callback arrays per call.
   */
  private readonly activeWaits = new Set<(info: BackgroundTaskInfo) => void>();

  constructor(private readonly manager: BackgroundProcessManager) {
    // ONE subscription for the tool's lifetime (not one per call): the
    // manager's `onLifecycle` has no unsubscribe, so per-call registration
    // would leak a closure into the manager on every Wait. Errors thrown by
    // deliver closures are swallowed by the manager's fan-out.
    this.manager.onLifecycle((event, info) => {
      if (event !== 'terminated') return;
      for (const deliver of this.activeWaits) deliver(info);
    });
  }

  resolveExecution(args: WaitInput): ToolExecution {
    return {
      description:
        args.task_id === undefined
          ? 'Waiting for a background task to finish'
          : `Waiting for task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id ?? 'any'),
      execute: (ctx) => this.execute(args, ctx),
    };
  }

  private async execute(
    args: WaitInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const { signal } = ctx;
    const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    // The zod schema rejects this at preflight; the direct guard covers
    // callers that reach the tool without schema validation.
    if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      return {
        isError: true,
        output: `timeout_seconds cannot exceed ${MAX_TIMEOUT_SECONDS} (10 minutes).`,
      };
    }
    const tailLines = Math.min(Math.max(1, args.tail_lines ?? DEFAULT_TAIL_LINES), MAX_TAIL_LINES);
    const taskId = args.task_id;

    // Ownership + already-settled fast paths: an unknown id and a finished
    // task must never block.
    if (taskId !== undefined) {
      const info = this.manager.getTask(taskId);
      if (info === undefined) {
        return {
          isError: true,
          output: `Task ${taskId} is not a task of this session.`,
        };
      }
      if (isBackgroundTaskTerminal(info.status)) {
        return this.terminalResult(info, tailLines);
      }
    } else if (this.manager.list(true).length === 0) {
      return { output: 'No background tasks are running.', isError: false };
    }

    if (signal.aborted) {
      return {
        isError: true,
        output: isParentInterject(signal.reason)
          ? 'Interrupted by the parent agent before the wait started'
          : 'Aborted before the wait started',
      };
    }

    const outcome = await this.block(taskId, timeoutSeconds, signal);

    if (outcome.kind === 'aborted') {
      // Interrupt convention (Bash / Python): an error result with the
      // attribution; the loop tags it `code: 'aborted'`.
      return {
        isError: true,
        output: `Wait interrupted by ${interruptedBy(signal)}.`,
      };
    }
    if (outcome.kind === 'timeout') {
      const lines = ['status: running'];
      if (taskId !== undefined) lines.push(`task_id: ${taskId}`);
      const remaining = this.manager.list(true).length;
      if (remaining > 0) {
        lines.push(
          remaining === 1 ? '1 other task still running.' : `${String(remaining)} other tasks still running.`,
        );
      }
      lines.push(
        `Wait timed out after ${String(timeoutSeconds)}s; the task is still running. ` +
          'Wait again or check TaskOutput.',
      );
      return { output: lines.join('\n'), isError: false };
    }

    // Prefer the post-settle registry snapshot; the event's info is the
    // fallback for a task that left the registry between settle and read.
    const info = this.manager.getTask(outcome.info.taskId) ?? outcome.info;
    return this.terminalResult(info, tailLines);
  }

  /**
   * Park until the target (or any) owned task turns terminal, the timeout
   * fires, or the turn's signal aborts. Event delivery is primary; the
   * ladder re-checks the registry in case an event was missed. Every timer
   * is cleared on settle, whichever path wins.
   */
  private block(
    taskId: string | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      let ladderTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (outcome: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        if (ladderTimer !== undefined) clearTimeout(ladderTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        signal.removeEventListener('abort', onAbort);
        this.activeWaits.delete(deliver);
        resolve(outcome);
      };

      const onAbort = (): void => {
        finish({ kind: 'aborted' });
      };
      signal.addEventListener('abort', onAbort);

      const deliver = (info: BackgroundTaskInfo): void => {
        if (settled) return;
        if (taskId !== undefined && info.taskId !== taskId) return;
        finish({ kind: 'terminal', info });
      };
      this.activeWaits.add(deliver);

      // Running task ids seen so far (any-task waits only). The winner of a
      // ladder-detected settle is the tracked task that turned terminal
      // first — earliest `endedAt`, so two near-simultaneous exits do not
      // depend on iteration order.
      const tracked = new Set<string>();
      if (taskId === undefined) {
        for (const task of this.manager.list(true)) tracked.add(task.taskId);
      }

      const firstTerminalWinner = (): BackgroundTaskInfo | undefined => {
        let winner: BackgroundTaskInfo | undefined;
        for (const id of tracked) {
          const info = this.manager.getTask(id);
          if (info === undefined || !isBackgroundTaskTerminal(info.status)) continue;
          if (winner === undefined || (info.endedAt ?? 0) < (winner.endedAt ?? 0)) winner = info;
        }
        return winner;
      };

      // One registry pass. Also run once when the overall timeout fires, so
      // a terminal state that events AND the ladder both missed (or that
      // landed in the same tick as the deadline) is still reported
      // accurately instead of as a bogus "still running".
      const checkRegistry = (): WaitOutcome | undefined => {
        if (taskId !== undefined) {
          const info = this.manager.getTask(taskId);
          if (info !== undefined && isBackgroundTaskTerminal(info.status)) {
            return { kind: 'terminal', info };
          }
          return undefined;
        }
        const winner = firstTerminalWinner();
        if (winner !== undefined) return { kind: 'terminal', info: winner };
        // Track tasks registered since the last pass: a task that becomes
        // owned mid-wait participates.
        for (const task of this.manager.list(true)) tracked.add(task.taskId);
        return undefined;
      };

      let step = 0;
      const scheduleNext = (): void => {
        const delay = step < WAIT_LADDER_MS.length ? WAIT_LADDER_MS[step]! : WAIT_LADDER_IDLE_MS;
        step += 1;
        ladderTimer = setTimeout(() => {
          ladderTimer = undefined;
          if (settled) return;
          const outcome = checkRegistry();
          if (outcome !== undefined) {
            finish(outcome);
            return;
          }
          scheduleNext();
        }, delay);
      };
      scheduleNext();

      timeoutTimer = setTimeout(() => {
        const outcome = settled ? undefined : checkRegistry();
        finish(outcome ?? { kind: 'timeout' });
      }, timeoutSeconds * 1000);
    });
  }

  /** Format a settled task: status, why it ended, output tail, remaining count. */
  private async terminalResult(
    info: BackgroundTaskInfo,
    tailLines: number,
  ): Promise<ExecutableToolResult> {
    const previewBudget = Math.min(TAIL_PREVIEW_BYTE_CAP, tailLines * TAIL_BYTES_PER_LINE);
    const output = await this.manager.getOutputSnapshot(info.taskId, previewBudget);
    const tail = tailFromPreview(output.preview, tailLines);

    const lines = [
      `task_id: ${info.taskId}`,
      `status: ${info.status}`,
      `description: ${info.description}`,
    ];
    if (info.exitCode !== null) lines.push(`exit_code: ${String(info.exitCode)}`);
    // Why the task ended, mirroring TaskOutput's terminal fields.
    if (info.timedOut === true) lines.push('timed_out: true');
    if (info.stopReason !== undefined) lines.push(`stop_reason: ${info.stopReason}`);
    if (output.outputPath !== undefined) lines.push(`output_path: ${output.outputPath}`);
    lines.push(`output_truncated: ${String(output.truncated)}`);
    lines.push(`tail (last ${String(tailLines)} lines):`, tail.length > 0 ? tail : '[no output available]');

    const remaining = this.manager.list(true).length;
    if (remaining > 0) {
      lines.push(
        '',
        remaining === 1 ? '1 other task still running.' : `${String(remaining)} other tasks still running.`,
      );
    }

    return {
      output: lines.join('\n'),
      isError: false,
      message: `Task ${info.taskId} finished (${info.status}).`,
    };
  }
}
