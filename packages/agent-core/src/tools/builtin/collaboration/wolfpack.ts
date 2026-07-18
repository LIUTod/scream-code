/**
 * WolfPackTool — batch parallel subagent execution.
 *
 * Spawns multiple subagents in parallel using a template + items pattern.
 * Each item gets its own subagent; results are batched together.
 * There is no artificial concurrency cap: all items spawn and run in parallel.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import type { ResolvedAgentProfile } from '../../../profile/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { buildSubagentDescriptions } from './agent';
import WOLFPACK_DESCRIPTION from './wolfpack.md';

// Unlimited subagent concurrency: spawn every item in parallel.

export const WolfPackToolInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('Short task description (3-5 words, e.g., "Security review all files")'),
  subagent_type: z
    .string()
    .default('coder')
    .describe('Subagent type for all spawned agents (e.g., coder, explore, verify)'),
  prompt_template: z
    .string()
    .min(1)
    .describe('Prompt template with {{item}} placeholder. Each item is substituted in.'),
  items: z
    .array(z.string().min(1))
    .min(1)
    .describe('Array of items to process. Each item gets its own subagent.'),
});

export type WolfPackToolInput = z.infer<typeof WolfPackToolInputSchema>;

/** Default per-subagent timeout (5 minutes). */
const DEFAULT_SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;

export class WolfPackTool implements BuiltinTool<WolfPackToolInput> {
  readonly name: string = 'WolfPack';
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WolfPackToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly isEnabled: () => boolean,
    options?: {
      subagents?: ResolvedAgentProfile['subagents'];
      log?: Logger;
      allowedSpawns?: string[];
      timeoutMs?: number;
    },
  ) {
    const visibleSubagents = filterSubagentsBySpawns(options?.subagents, options?.allowedSpawns);
    const typeLines = buildSubagentDescriptions(visibleSubagents);
    this.description = typeLines
      ? `${WOLFPACK_DESCRIPTION}\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`
      : WOLFPACK_DESCRIPTION;
    this.log = options?.log;
    this.allowedSpawns = options?.allowedSpawns;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  }

  private readonly log?: Logger;
  private readonly allowedSpawns?: string[];
  private readonly timeoutMs: number;

  resolveExecution(args: WolfPackToolInput): ToolExecution {
    return {
      description: `WolfPack: ${args.description} (${args.items.length} agents)`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'generic',
        summary: `WolfPack: ${args.description}`,
        detail: { itemCount: args.items.length, subagent_type: args.subagent_type },
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WolfPackToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    ctx.signal.throwIfAborted();

    if (!this.isEnabled()) {
      return {
        output: 'WolfPack mode is not enabled. Use /wolfpack to enable it first.',
        isError: true,
      };
    }

    const profileName = args.subagent_type ?? 'coder';
    if (this.allowedSpawns !== undefined && !this.allowedSpawns.includes(profileName)) {
      return {
        output: `Cannot spawn "${profileName}" via WolfPack. Allowed subagents: ${this.allowedSpawns.join(', ')}.`,
        isError: true,
      };
    }

    const template = args.prompt_template;

    // Spawn every requested subagent in parallel (unlimited concurrency mode).
    const handlePromises = args.items.map(async (item) => {
      ctx.signal.throwIfAborted();
      try {
        const prompt = template.replaceAll('{{item}}', () => item);
        const handle = await this.subagentHost.spawn(profileName, {
          parentToolCallId: ctx.toolCallId,
          prompt,
          description: `${args.description}: ${item}`,
          runInBackground: false,
          signal: ctx.signal,
        });
        return { item, handle };
      } catch (error) {
        return { item, error };
      }
    });

    const handleResults = await Promise.allSettled(handlePromises);
    const completionPromises = handleResults.map(
      async (settled): Promise<{ item: string; result: string; success: boolean; agentId?: string }> => {
        if (settled.status === 'rejected') {
          const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          return { item: 'unknown', result: `Spawn failed: ${msg}`, success: false };
        }

        const value = settled.value;
        if ('error' in value) {
          const msg = value.error instanceof Error ? value.error.message : String(value.error);
          return { item: value.item, result: `Spawn failed: ${msg}`, success: false };
        }

        const { item, handle } = value;

        try {
          const completion = await withTimeout(
            handle.completion,
            this.timeoutMs,
            ctx.signal,
          );
          return {
            item,
            result: completion.result,
            success: true,
            agentId: handle.agentId,
          };
        } catch (error) {
          let message: string;
          if (isAbortError(error)) {
            message = 'The subagent was stopped before it finished.';
          } else {
            message = error instanceof Error ? error.message : String(error);
          }
          return { item, result: message, success: false, agentId: handle.agentId };
        }
      },
    );

    const completions = await Promise.allSettled(completionPromises);

    // Build aggregate output
    let successCount = 0;
    let failureCount = 0;
    const lines: string[] = [];

    for (const settled of completions) {
      if (settled.status === 'fulfilled') {
        const { item, result, success, agentId } = settled.value;
        if (success) {
          successCount++;
          lines.push(`### ${item} (OK)`);
        } else {
          failureCount++;
          lines.push(`### ${item} (FAILED)`);
        }
        if (agentId !== undefined) {
          lines.push(`agent_id: ${agentId}`);
        }
        if (result.length > 0) {
          lines.push(result);
        }
      } else {
        failureCount++;
        const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        lines.push(`### error: ${msg}`);
      }
      lines.push('');
    }

    const summary = `Success: ${successCount}, Failed: ${failureCount}, Total: ${completions.length}`;

    if (failureCount > 0 && successCount === 0) {
      return {
        output: [summary, '', ...lines].join('\n'),
        isError: true,
      };
    }

    return { output: [summary, '', ...lines].join('\n') };
  }
}

function filterSubagentsBySpawns(
  subagents: ResolvedAgentProfile['subagents'] | undefined,
  allowedSpawns: string[] | undefined,
): ResolvedAgentProfile['subagents'] | undefined {
  if (allowedSpawns === undefined || subagents === undefined) return subagents;
  return Object.fromEntries(
    Object.entries(subagents).filter(([name]) => allowedSpawns.includes(name)),
  );
}

/**
 * Wraps a promise with a per-subagent timeout. If the parent signal aborts
 * before the timeout fires, the timeout is cleared and the parent abort
 * propagates naturally. On timeout, the returned promise rejects with a
 * descriptive error.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<T> {
  if (parentSignal.aborted) return Promise.reject(new Error('Aborted before start'));

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Subagent timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const onParentAbort = () => {
      cleanup();
      reject(new Error('The subagent was stopped before it finished.'));
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
