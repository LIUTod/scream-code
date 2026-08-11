/**
 * Pure helper functions extracted from TurnFlow (agent/turn/index.ts).
 *
 * These functions have no dependency on TurnFlow instance state; they exist
 * here so the turn orchestration class stays readable and the pure logic can
 * be unit-tested in isolation. Bodies are byte-identical to their original
 * inline forms — moving code, never changing behavior.
 */

import { toScreamErrorPayload, type ScreamErrorPayload } from '#/errors';
import type { ExecutableToolResult, LoopEvent } from '../../loop/index';
import type { AgentEvent, TurnEndedEvent } from '../../rpc';
import type { ContextMessage } from '../context';

/** Builds the error text synthesized for tool calls abandoned when a live
 * turn ends (cancelled, failed, or completed) before their results arrived. */
export function abandonedToolResultOutput(ended: TurnEndedEvent): string {
  const cause =
    ended.reason === 'cancelled'
      ? 'the turn was cancelled'
      : ended.reason === 'failed'
        ? `the turn failed${ended.error !== undefined ? ` (${ended.error.message})` : ''}`
        : 'the turn ended';
  return `Tool call did not complete: ${cause} before its result was recorded. Do not assume the tool completed successfully.`;
}

export function getAssistantMessageText(message: ContextMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export const TRIVIAL_COMPLETION_RE =
  /^\s*(done|ok|okay|完成|好了|ok\.?|done\.?|completed\.?|finished\.?|tests?\s+passed\.?|passed\.?|it\s+works\.?|looks\s+good\.?|fixed\.?|resolved\.?|verified\.?|all\s+good\.?|一切正常\.?|已完成\.?)\s*$/iu;

export function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
        display:
          event.result.isError === true ? undefined : event.result.display,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

export const LLM_NOT_SET_MESSAGE =
  'No model configured. Run `scream config` or use `/model` to set a default model.';

export function summarizeTurnError(error: unknown, turnId: number): ScreamErrorPayload {
  const payload = toScreamErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

export function toolInputRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * Parse a `[verification_status]` block from verify-agent output.
 * Returns undefined if no block is found.
 */
export function parseVerificationStatus(
  output: string,
): { passed: boolean; command: string; exitCode: number } | undefined {
  const match = output.match(/\[verification_status\]\s*\n([\s\S]*?)(?=\n\n|\n?$)/);
  if (!match || match[1] === undefined) return undefined;
  const block = match[1];
  const passedMatch = block.match(/^passed:\s*(true|false)\s*$/im);
  const commandMatch = block.match(/^command:\s*(.+)$/im);
  const exitCodeMatch = block.match(/^exit_code:\s*(\d+)\s*$/im);
  if (
    !passedMatch ||
    !commandMatch ||
    !exitCodeMatch ||
    passedMatch[1] === undefined ||
    commandMatch[1] === undefined ||
    exitCodeMatch[1] === undefined
  ) {
    return undefined;
  }
  return {
    passed: passedMatch[1].toLowerCase() === 'true',
    command: commandMatch[1].trim(),
    exitCode: Number.parseInt(exitCodeMatch[1], 10),
  };
}

export function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

/** Extract a short human-readable summary from tool arguments. */
export function summarizeToolArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  // Common tool arg patterns — try each in priority order
  if (typeof a['file_path'] === 'string') return a['file_path'];
  if (typeof a['path'] === 'string') return a['path'];
  if (typeof a['description'] === 'string') return truncateArg(a['description']);
  if (typeof a['subject'] === 'string') return a['subject'];
  if (typeof a['command'] === 'string') return truncateArg(a['command']);
  if (typeof a['query'] === 'string') return truncateArg(a['query']);
  if (typeof a['url'] === 'string') return a['url'];
  return '';
}

function truncateArg(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

/**
 * Classify a Bash command as "exploratory" (probing the environment) vs
 * "blocking" (a command whose failure means the task cannot be delivered).
 * Exploratory failures (e.g. probing for tsc, ls, which) do not block once
 * the turn has produced a successful resolution.
 */
export function isExploratoryBashCommand(command: string): boolean {
  const normalized = command.toLowerCase().trim();
  // Probing for toolchain binaries or inspecting the environment should not
  // keep the turn alive once a working alternative has been found. These
  // patterns can appear anywhere in the command (e.g. after `cd ... && `).
  const exploratoryPatterns = [
    /\bwhich\s+/,
    /\bwhereis\s+/,
    /\bcommand\s+-v\s+/,
    /\btype\s+/,
    /\bls\s+/,
    /\bfind\s+/,
    /\bglob\s+/,
    /\bnpm\s+list\s+-g/,
    /\bcat\s+/,
    /\bhead\s+/,
    /\btail\s+/,
    /\becho\s+/,
    /\btest\s+-[efdx]/,
    /\[\s+-[efdx]/,
    // Trying to invoke `tsc`/`tsx`/etc. without the package installed is an
    // environment probe. The real verification happens once typescript/tsx
    // is available (e.g. `npx -p typescript tsc`).
    /(^|;\s*|&&\s*)\s*npx\s+tsc\s/,
    /(^|;\s*|&&\s*)\s*npx\s+tsx\s/,
    /(^|;\s*|&&\s*)\s*npx\s+typescript\s/,
    /(^|;\s*|&&\s*)\s*tsc\s/,
    /(^|;\s*|&&\s*)\s*tsx\s/,
    // Installing typescript/tsx to enable verification is also exploratory.
    /(^|;\s*|&&\s*)\s*npm\s+install\s+(--no-save\s+)?typescript/,
    /(^|;\s*|&&\s*)\s*npm\s+install\s+(--no-save\s+)?tsx/,
    /(^|;\s*|&&\s*)\s*pnp[ms]\s+add\s+(--global\s+)?typescript/,
    /(^|;\s*|&&\s*)\s*pnp[ms]\s+add\s+(--global\s+)?tsx/,
    /(^|;\s*|&&\s*)\s*yarn\s+add\s+(--dev\s+)?typescript/,
    /(^|;\s*|&&\s*)\s*yarn\s+add\s+(--dev\s+)?tsx/,
    // Common read-only / exploratory probes
    /\bgit\s+status\b/,
    /\bgit\s+diff\b/,
    /\bgit\s+log\b/,
    /\bgrep\s+/,
    /\brg\s+/,
    /\bnode\s+-e\s+/,
    /\bpython\b/,
    /\bpython3\b/,
    /\bwc\s+/,
    /\bsort\s+/,
    /\buniq\b/,
    /\bdiff\s+/,
    /\bfile\s+/,
    /\bstat\s+/,
    /\bdf\s+/,
    /\bdu\s+/,
  ];
  return exploratoryPatterns.some((pattern) => pattern.test(normalized));
}
