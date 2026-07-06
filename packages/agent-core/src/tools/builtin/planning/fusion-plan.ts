/**
 * FusionPlanTool — plan-mode helper that spawns parallel planning subagents
 * from different angles and synthesizes their outputs into a single plan.
 *
 * Unlike the old TUI-layer fusion plan scheduler, this tool runs inside the
 * agent loop and reuses SessionSubagentHost / AgentTool infrastructure. The
 * TUI sees it as a normal tool call with nested subagent progress.
 */

import { z } from 'zod';

import type { Agent } from '#/agent';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { BuiltinTool } from '../../../agent/tool';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './fusion-plan.md';

const MIN_WORKERS = 1;
const MAX_WORKERS = 3;
const DEFAULT_WORKER_COUNT = 3;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_MAX_OUTPUT_BYTES = 8_000;
const DEFAULT_SYNTHESIS_MAX_OUTPUT_BYTES = 12_000;

const WORKER_ANGLES = [
  {
    angle: 'Focus on correctness and edge cases. Identify risks, invariants, and safety checks.',
    label: '最佳正确性',
  },
  {
    angle: 'Focus on minimal invasiveness. Prefer small, incremental changes that are easy to review.',
    label: '最小侵入性',
  },
  {
    angle: 'Focus on architecture and future maintainability. Consider testability, clarity, and naming.',
    label: '最优架构性',
  },
] as const;

export const FusionPlanInputSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe('The implementation task or user request to plan.'),
  worker_count: z
    .number()
    .int()
    .min(MIN_WORKERS)
    .max(MAX_WORKERS)
    .optional()
    .describe(`Number of parallel planning angles (default ${DEFAULT_WORKER_COUNT}, max ${MAX_WORKERS}).`),
  timeout_seconds: z
    .number()
    .int()
    .min(MIN_TIMEOUT_SECONDS)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`Per-worker timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}).`),
});

export type FusionPlanInput = z.infer<typeof FusionPlanInputSchema>;

export class FusionPlanTool implements BuiltinTool<FusionPlanInput> {
  readonly name = 'FusionPlan' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FusionPlanInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: FusionPlanInput): ToolExecution {
    return {
      description: `Fusion planning: ${args.task.slice(0, 60)}${args.task.length > 60 ? '...' : ''}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FusionPlanInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (this.agent.type !== 'main') {
      return {
        isError: true,
        output: 'FusionPlan can only be invoked by the main agent.',
      };
    }

    const subagentHost = this.agent.subagentHost;
    if (subagentHost === undefined) {
      return {
        isError: true,
        output: 'Subagent host is not available.',
      };
    }

    const workerCount = Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, args.worker_count ?? DEFAULT_WORKER_COUNT));
    const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
    const synthesisMaxOutputBytes = DEFAULT_SYNTHESIS_MAX_OUTPUT_BYTES;
    const signal = ctx.signal;

    signal.throwIfAborted();

    // 1. Spawn parallel plan subagents, one per angle.
    const workerPromises: Array<Promise<{ ok: boolean; output: string; label: string }>> = [];
    for (let i = 0; i < workerCount; i += 1) {
      const angleDef = WORKER_ANGLES[i % WORKER_ANGLES.length]!;
      const prompt = buildPlannerPrompt({ task: args.task, angle: angleDef.angle, maxOutputBytes });
      const label = angleDef.label;

      workerPromises.push(
        (async (): Promise<{ ok: boolean; output: string; label: string }> => {
          try {
            const handle = await subagentHost.spawn('plan', {
              parentToolCallId: ctx.toolCallId,
              prompt,
              description: `Plan angle: ${label}`,
              runInBackground: false,
              signal,
            });
            const completion = await handle.completion;
            return { ok: true, output: completion.result, label };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, output: message, label };
          }
        })(),
      );
    }

    const workerResults = await Promise.all(workerPromises);
    const successfulOutputs = workerResults.filter((r) => r.ok);

    if (successfulOutputs.length === 0) {
      const details = workerResults
        .map((r, i) => `worker ${i + 1} (${r.label}): ${r.output}`)
        .join('\n');
      return {
        isError: true,
        output: `All fusion plan workers failed.\n\n${details}`,
      };
    }

    signal.throwIfAborted();

    // 2. Synthesize successful outputs into one plan.
    const truncatedOutputs = successfulOutputs.map((r) =>
      truncateUtf8(r.output, maxOutputBytes),
    );
    const synthesisPrompt = buildSynthesisPrompt({
      task: args.task,
      workerOutputs: truncatedOutputs,
      maxOutputBytes: synthesisMaxOutputBytes,
    });

    let finalPlan: string;
    try {
      const synthesisHandle = await subagentHost.spawn('plan', {
        parentToolCallId: ctx.toolCallId,
        prompt: synthesisPrompt,
        description: 'Synthesize plans',
        runInBackground: false,
        signal,
      });
      const synthesisCompletion = await synthesisHandle.completion;
      finalPlan = synthesisCompletion.result.trim();
    } catch (error) {
      // Fall back to concatenating successful outputs if synthesis subagent fails.
      finalPlan = truncatedOutputs.join('\n\n---\n\n');
    }

    if (finalPlan.length === 0) {
      return {
        isError: true,
        output: 'Fusion plan synthesis produced no output.',
      };
    }

    signal.throwIfAborted();

    // 3. Enter/ensure plan mode with fusion strategy and write the plan file.
    try {
      if (!this.agent.planMode.isActive) {
        const id = this.agent.planMode.createPlanId();
        await this.agent.planMode.enter(id, false, true, 'fusion');
      } else {
        // Ensure strategy reflects fusion planning for downstream prompts/status.
        this.agent.planMode.setStrategy('fusion');
      }

      const planFilePath = this.agent.planMode.planFilePath;
      if (planFilePath === null) {
        return {
          isError: true,
          output: 'Failed to obtain a plan file path.',
        };
      }

      await this.agent.jian.writeText(planFilePath, finalPlan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        output: `Failed to write the fusion plan: ${message}`,
      };
    }

    return {
      isError: false,
      output: `Fusion plan generated and saved to ${this.agent.planMode.planFilePath ?? 'plan file'}.\n\n${finalPlan.slice(0, 400)}${finalPlan.length > 400 ? '...' : ''}`,
    };
  }
}

function buildPlannerPrompt(input: { task: string; angle: string; maxOutputBytes: number }): string {
  return [
    'Create an implementation plan for the request below.',
    '',
    `Request: ${input.task}`,
    '',
    `Your specific angle: ${input.angle}`,
    '',
    'Constraints:',
    '- Investigate the codebase as needed using available tools.',
    '- Produce a concrete, step-by-step implementation plan.',
    '- Do not write implementation code; only produce the plan.',
    `- Keep your response focused and under ${input.maxOutputBytes} bytes.`,
    '- Return only the plan.',
  ].join('\n');
}

function buildSynthesisPrompt(input: {
  task: string;
  workerOutputs: readonly string[];
  maxOutputBytes: number;
}): string {
  const plans = input.workerOutputs
    .map((output, index) => `### Plan ${index + 1}\n\n${output}`)
    .join('\n\n');
  return [
    'Review the following plans from multiple planning specialists and synthesize them into a single optimal implementation plan.',
    '',
    `Request: ${input.task}`,
    '',
    plans,
    '',
    'Instructions:',
    '- Incorporate the strongest ideas from each specialist plan.',
    '- Resolve contradictions explicitly.',
    '- Produce one concrete, step-by-step implementation plan.',
    `- Keep the final plan under ${input.maxOutputBytes} bytes.`,
    '- Return only the final plan.',
  ].join('\n');
}

export function truncateUtf8(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;
  const suffix = '…';
  const suffixBytes = encoder.encode(suffix).length;
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(input.slice(0, mid)).length <= targetBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${input.slice(0, low)}${suffix}`;
}
