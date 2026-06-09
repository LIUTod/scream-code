/**
 * WolfPackTool — batch parallel subagent execution.
 *
 * Spawns multiple subagents in parallel using a template + items pattern.
 * Each item gets its own subagent; results are batched together.
 * V1 uses Promise.allSettled — no concurrency control or rate-limit handling.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost, SubagentHandle } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import WOLFPACK_DESCRIPTION from './wolfpack.md';

const MAX_ITEMS = 20;

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
    .max(MAX_ITEMS)
    .describe('Array of items to process. Each item gets its own subagent.'),
});

export type WolfPackToolInput = z.infer<typeof WolfPackToolInputSchema>;

export class WolfPackTool implements BuiltinTool<WolfPackToolInput> {
  readonly name: string = 'WolfPack';
  readonly description: string = WOLFPACK_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WolfPackToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly isEnabled: () => boolean,
    _options?: { log?: Logger },
  ) {}

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
        output: 'WolfPack 模式未开启。请输入 /wolfpack 打开后再试。',
        isError: true,
      };
    }

    if (args.items.length > MAX_ITEMS) {
      return {
        output: `WolfPack max ${MAX_ITEMS} items. Got ${args.items.length}.`,
        isError: true,
      };
    }

    const profileName = args.subagent_type ?? 'coder';
    const template = args.prompt_template;

    // Spawn all subagents in parallel
    const handlePromises = args.items.map(
      async (item): Promise<{ item: string; handle: SubagentHandle }> => {
        ctx.signal.throwIfAborted();
        const prompt = template.replace(/\{\{item\}\}/g, item);
        const handle = await this.subagentHost.spawn(profileName, {
          parentToolCallId: ctx.toolCallId,
          prompt,
          description: `${args.description}: ${item}`,
          runInBackground: false,
          signal: ctx.signal,
        });
        return { item, handle };
      },
    );

    const handleResults = await Promise.allSettled(handlePromises);

    // Wait for all completions
    const completionPromises = handleResults.map(
      async (settled): Promise<{ item: string; result: string; success: boolean; agentId?: string }> => {
        if (settled.status === 'rejected') {
          const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          return { item: 'unknown', result: `Spawn failed: ${msg}`, success: false };
        }

        const { item, handle } = settled.value;
        try {
          const completion = await handle.completion;
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
        const { item, result: _result, success, agentId } = settled.value;
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
