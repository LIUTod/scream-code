/**
 * FanOut tool — spawn multiple subagents in parallel and aggregate results.
 *
 * Unlike `Agent` which spawns one subagent per call, FanOut accepts an array
 * of tasks and dispatches them concurrently via SessionSubagentHost.  All
 * subagents run in the foreground (blocking the parent turn) and the tool
 * returns once every subagent has completed or timed out.
 *
 * Safety:
 *   - Maximum 5 concurrent subagents (hard cap).
 *   - 5-minute deadline per subagent (avoids runaway token burn).
 *   - ConflictTracker performs pre-spawn overlap detection on task prompts
 *     and injects file-safety warnings into subagent prompts when it detects
 *     potential conflicts (best-effort; hard real-time lock requires hook
 *     system JS-callback support — Phase 2).
 *
 * Model guidance (system prompt):
 *   - Use FanOut for independent subtasks operating on different files/dirs.
 *   - Use sequential Agent calls when tasks have dependencies or share files.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { isAbortError } from '../../../loop/errors';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import {
  createDeadlineAbortSignal,
  isUserCancellation,
  type DeadlineAbortSignal,
} from '../../../utils/abort';
import { toInputJsonSchema } from '../../support/input-schema';

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_PARALLEL = 5;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per subagent

// ── Input schema ───────────────────────────────────────────────────────────

const FanOutTaskSchema = z.object({
  description: z.string().describe('Short task description (3-5 words) for UI display'),
  prompt: z.string().describe('Full task prompt for the subagent'),
  subagent_type: z
    .string()
    .optional()
    .describe('Subagent profile type: "coder", "explore", "plan", "verify", or "writer". Defaults to "coder".'),
});

export const FanOutInputSchema = z.object({
  tasks: z
    .array(FanOutTaskSchema)
    .min(1)
    .max(MAX_PARALLEL)
    .describe(`Array of tasks to execute in parallel (max ${MAX_PARALLEL}).`),
});

export type FanOutInput = z.infer<typeof FanOutInputSchema>;

// ── ConflictTracker (pre-spawn best-effort analysis) ───────────────────────
//
// Scans task prompts for file/directory path patterns and detects when two
// or more tasks are likely to touch the same area of the project.  Detected
// overlaps trigger a safety suffix injected into each affected subagent's
// prompt.
//
// This is a SOFT guard — it helps the model avoid conflicts but does NOT
// provide hard real-time execution guarantees.  Hard file-level locking
// (intercepting Write/Edit tool calls across subagents) requires extending
// the hook system to support JavaScript callbacks, tracked as Phase 2.

const FILE_PATH_RE = /(?:^|\s)([.\\/\w-]+\.[\w]+|src\/[\w/-]+|packages\/[\w/-]+|apps\/[\w/-]+)(?:\s|$|[,.;:])/gi;

const CONFLICT_WARNING = [
  '',
  '⚠️ FILE SAFETY: Another subagent in this FanOut batch may also be working',
  'with the same files or directories. Before writing to any file:',
  '  1. Read the file first to get its latest state.',
  '  2. If the file has been modified since you last read it, adapt accordingly.',
  '  3. Prefer Edit (surgical changes) over Write (full overwrite).',
  '  4. If you detect a merge conflict, report it instead of forcing a write.',
].join('\n');

class ConflictTracker {
  /** Extract file/directory references from a task description + prompt. */
  extractRefs(task: { description: string; prompt: string }): string[] {
    const text = `${task.description}\n${task.prompt}`;
    const refs: string[] = [];
    for (const match of text.matchAll(FILE_PATH_RE)) {
      const path = match[1];
      if (path && path.length > 1) {
        refs.push(path.toLowerCase());
      }
    }
    return [...new Set(refs)];
  }

  /**
   * Analyze all tasks for file overlaps.  Returns a Set of task indices that
   * should receive a conflict warning in their prompt.
   */
  analyze(tasks: readonly { description: string; prompt: string }[]): Set<number> {
    const taskRefs = tasks.map((t, i) => ({ index: i, refs: this.extractRefs(t) }));
    const warned = new Set<number>();

    for (let i = 0; i < taskRefs.length; i++) {
      for (let j = i + 1; j < taskRefs.length; j++) {
        const a = taskRefs[i]!;
        const b = taskRefs[j]!;
        const hasOverlap = a.refs.some(
          (refA) => b.refs.some((refB) => refA === refB || refA.startsWith(refB) || refB.startsWith(refA)),
        );
        if (hasOverlap) {
          warned.add(a.index);
          warned.add(b.index);
        }
      }
    }

    return warned;
  }
}

// ── FanOut tool ────────────────────────────────────────────────────────────

export class FanOutTool implements BuiltinTool<FanOutInput> {
  readonly name: string = 'FanOut';
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FanOutInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {
    this.description = [
      `Spawn up to ${MAX_PARALLEL} subagents in parallel and wait for all results.`,
      '',
      '✅ Use FanOut when:',
      '  - Analyzing/reviewing independent modules (non-overlapping files)',
      '  - Multi-perspective evaluation (security, performance, code quality)',
      '  - Large-scale refactors across different directories',
      '',
      '❌ Do NOT use FanOut when:',
      '  - Tasks have dependencies (one needs the other\'s output)',
      '  - Multiple tasks would write to the same file or directory',
      '  - The task is simple enough for a single Agent call',
      '',
      `Each subagent gets ${DEFAULT_TIMEOUT_MS / 60000} minutes max.`,
      'When in doubt, use sequential Agent calls — they\'re safer.',
    ].join('\n');
  }

  resolveExecution(args: FanOutInput): ToolExecution {
    return {
      description: `FanOut: ${args.tasks.length} agents — ${args.tasks.map((t) => t.description).join(', ')}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'generic',
        summary: `Launching ${args.tasks.length} parallel agents`,
        detail: args.tasks.map((t) => t.description).join(', '),
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FanOutInput,
    { signal, toolCallId }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const tasks = args.tasks.slice(0, MAX_PARALLEL);

    // ── Pre-spawn conflict analysis ──────────────────────────────────
    const tracker = new ConflictTracker();
    const conflictIndices = tracker.analyze(tasks);

    // Declared outside try so the catch block can clean up deadlines and
    // cancel orphaned subagents on abort.
    const handles: Array<{
      index: number;
      description: string;
      handle: Awaited<ReturnType<SessionSubagentHost['spawn']>>;
      deadline: DeadlineAbortSignal;
    }> = [];

    try {
      signal.throwIfAborted();

      // ── Spawn all subagents concurrently ────────────────────────────

      const spawnResults = await Promise.allSettled(
        tasks.map(async (task, index) => {
          const deadline = createDeadlineAbortSignal(signal, DEFAULT_TIMEOUT_MS);
          try {
            // Inject conflict warning into prompt if overlap detected
            let prompt = task.prompt;
            if (conflictIndices.has(index)) {
              prompt = task.prompt + CONFLICT_WARNING;
            }

            const handle = await this.subagentHost.spawn(task.subagent_type ?? 'coder', {
              parentToolCallId: toolCallId,
              prompt,
              description: task.description,
              runInBackground: false,
              signal: deadline.signal,
            });
            return { index, description: task.description, handle, deadline };
          } catch (spawnError) {
            // Spawn failed — clean up the deadline timer before rethrowing.
            // The outer Promise.allSettled will capture the rejection, so the
            // deadline is not stored in `handles` and would otherwise leak.
            deadline.clear();
            throw spawnError;
          }
        }),
      );

      for (const result of spawnResults) {
        if (result.status === 'fulfilled') {
          handles.push(result.value);
        }
      }

      if (handles.length === 0) {
        // Surface individual spawn failure reasons so the model can diagnose
        // why all subagents failed (e.g. profile not found, rate limiting).
        const failures: string[] = [];
        for (let i = 0; i < spawnResults.length; i++) {
          const r = spawnResults[i]!;
          if (r.status === 'rejected') {
            failures.push(`[${i + 1}/${tasks.length}] ${String(r.reason)}`);
          }
        }
        return {
          output: [
            `FanOut: all ${tasks.length} subagents failed to spawn.`,
            '',
            'Failures:',
            ...failures.map((f) => `  ${f}`),
          ].join('\n'),
          isError: true,
        };
      }

      // ── Wait for all to complete ────────────────────────────────────
      const outcomeEntries = await Promise.allSettled(
        handles.map(async ({ index, description, handle, deadline }) => {
          try {
            const completed = await handle.completion;
            return {
              index,
              description,
              result: completed.result,
              status: 'completed' as const,
            };
          } catch (error) {
            let message: string;
            if (deadline.timedOut()) {
              message = `Subagent timed out after ${DEFAULT_TIMEOUT_MS / 60000} minutes.`;
            } else if (isUserCancellation(signal.reason)) {
              message = 'Cancelled by user.';
            } else if (isAbortError(error)) {
              message = 'Subagent was stopped before completion.';
            } else {
              message = error instanceof Error ? error.message : String(error);
            }
            return {
              index,
              description,
              result: '',
              status: 'failed' as const,
              error: message,
            };
          } finally {
            deadline.clear();
          }
        }),
      );

      // ── Aggregate results ───────────────────────────────────────────
      const parts: string[] = [];
      let hasFailures = false;

      for (const entry of outcomeEntries) {
        if (entry.status === 'rejected') {
          parts.push(`[?] subagent result lost: ${String(entry.reason)}`);
          hasFailures = true;
          continue;
        }

        const item = entry.value;
        if (item.status === 'failed') hasFailures = true;

        const statusTag = item.status === 'completed' ? '✅' : '❌';
        parts.push(
          [
            `${statusTag} [${item.index + 1}/${tasks.length}] ${item.description}`,
            `   status: ${item.status}`,
            item.error ? `   error: ${item.error}` : '',
            '',
            item.result || '(no output)',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      // Sort by original index
      const sorted = parts.sort((a, b) => {
        const idxA = a.match(/\[(\d+)\/\d+\]/)?.[1] ?? '99';
        const idxB = b.match(/\[(\d+)\/\d+\]/)?.[1] ?? '99';
        return Number(idxA) - Number(idxB);
      });

      const output = sorted.join('\n' + '─'.repeat(40) + '\n\n');

      return { output, ...(hasFailures ? { isError: true } : {}) };
    } catch (error) {
      // Clean up any subagents that were successfully spawned but not
      // yet completed. Without this, they would continue running as
      // orphans consuming tokens and potentially modifying files.
      //
      // NOTE: cancelAll() cancels every foreground subagent in the
      // session, not just this FanOut batch.  If another concurrent
      // tool call has live subagents they will also be stopped.  This
      // is a known limitation — per-handle cancellation requires a
      // SubagentHandle.cancel() API tracked for a follow-up.
      for (const { deadline } of handles) {
        deadline.clear();
      }
      this.subagentHost.cancelAll();

      let message: string;
      if (isUserCancellation(signal.reason)) {
        message = 'FanOut cancelled by user.';
      } else if (isAbortError(error)) {
        message = 'FanOut was stopped before completion.';
      } else {
        message = error instanceof Error ? error.message : String(error);
      }
      return { output: `FanOut error: ${message}`, isError: true };
    }
  }
}
