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
    .describe('The goal, in one sentence.'),
  approach: z
    .string()
    .min(1)
    .describe('What was done.'),
  outcome: z
    .string()
    .min(1)
    .describe('How it ended, e.g. "完成", "失败: reason".'),
  whatFailed: z
    .string()
    .optional()
    .describe('What did not work, or "none".'),
  whatWorked: z
    .string()
    .optional()
    .describe('What worked, or "none".'),
  tags: z
    .array(z.string())
    .optional()
    .describe('3-5 tags: domain, stack or action, e.g. ["react", "auth"].'),
  note: z
    .string()
    .optional()
    .describe('Optional one-line advice for reusing it.'),
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
    'Save an experience to memory when the user asks you to remember it ("记住这个", "记一下", "以后记得", "save this to memory"), ' +
    'written so a later session can reuse it.';
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
        const note = args.note ? stripMemoryTags(args.note).trim() : undefined;

        const memo = createMemoryMemo({
          sourceSessionId: sessionId,
          sourceSessionTitle,
          userNeed,
          approach,
          outcome,
          whatFailed: whatFailed.length === 0 ? 'none' : whatFailed,
          whatWorked: whatWorked.length === 0 ? 'none' : whatWorked,
          tags,
          note: note && note.length > 0 ? note : undefined,
          extractionSource: 'manual',
          projectDir: this.agent.config.cwd,
        });

        await store.append(memo);

        return {
          isError: false,
          output: `Memory saved: ${memo.userNeed} (id: ${memo.id})`,
        };
      },
    };
  }
}
