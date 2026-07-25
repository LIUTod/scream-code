import { createMemoryMemo, generateTags, normalizeTags, stripMemoryTags } from '@scream-code/memory';
import { dirname, basename } from 'pathe';
import { z } from 'zod';

import type { Agent } from '#/agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

export const MemoryWriteInputSchema = z.object({
  userNeed: z
    .string()
    .min(1)
    .describe('The user need or goal, summarized in one sentence.'),
  approach: z
    .string()
    .min(1)
    .describe('The approach taken — what was actually done.'),
  outcome: z
    .string()
    .min(1)
    .describe('Final outcome, e.g. "完成", "部分完成", "失败".'),
  whatFailed: z
    .string()
    .optional()
    .describe('Dead ends tried — things that did not work. Use "none" if nothing notable.'),
  whatWorked: z
    .string()
    .optional()
    .describe('What ultimately worked — key actions that led to success. Use "none" if nothing notable.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('3-5 semantic tags summarizing the task domain, tech stack, or action type (e.g. ["react", "auth", "部署"]).'),
});

export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

/**
 * Lets the model actively write a new memory memo to the global store.
 * Call this when the user explicitly asks to save something to memory,
 * e.g. "保存到记忆", "保存到备忘录", or "总结并保存".
 */
export class MemoryWriteTool implements BuiltinTool<MemoryWriteInput> {
  readonly name = 'MemoryWrite' as const;
  readonly description =
    'Write a new memory memo to the global memory memo store. ' +
    'Call this when the user explicitly asks to save an experience, lesson, or summary to memory, ' +
    'for example "保存到记忆", "保存到备忘录", "总结并保存", "永久记忆", "记录我的记忆", "记住这个", "添加到记忆", or "存入记忆库".';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryWriteInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MemoryWriteInput): ToolExecution {
    return {
      description: 'Writing memory memo',
      approvalRule: this.name,
      execute: async () => {
        const store = this.agent.memoStore;
        if (!store) {
          return { isError: true, output: 'Memory memo store is not available.' };
        }

        // homedir = <projectDir>/<sessionId>/agents/<agentId>
        const sessionId = this.agent.homedir
          ? basename(dirname(dirname(this.agent.homedir)))
          : 'unknown';
        const sourceSessionTitle = await this.agent.getSessionTitle();

        // Strip any injected memory-memo content from the fields before storing,
        // so recalled/compacted content cannot be re-stored and form a feedback
        // loop (recall -> consolidate -> re-recall).
        const userNeed = stripMemoryTags(args.userNeed);
        const approach = stripMemoryTags(args.approach);
        const outcome = stripMemoryTags(args.outcome);
        const whatFailed = stripMemoryTags(args.whatFailed ?? '');
        const whatWorked = stripMemoryTags(args.whatWorked ?? '');
        const tags = normalizeTags(
          args.tags !== undefined && args.tags.length > 0
            ? args.tags
            : generateTags(`${userNeed} ${approach}`),
        );

        const memo = createMemoryMemo({
          sourceSessionId: sessionId,
          sourceSessionTitle,
          userNeed,
          approach,
          outcome,
          whatFailed: whatFailed.length === 0 ? 'none' : whatFailed,
          whatWorked: whatWorked.length === 0 ? 'none' : whatWorked,
          tags,
          extractionSource: 'manual',
          projectDir: this.agent.config.cwd,
        });

        await store.append(memo);

        return {
          isError: false,
          output: `已保存记忆：${memo.userNeed}（id: ${memo.id}）`,
        };
      },
    };
  }
}
