import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodemodeSandbox,
  CodemodeSourceError,
  parseCodemodeSource,
  renderDeclarations,
  type CodemodeError,
  type CodemodeJsonSchema,
  type CodemodeOutputItem,
  type CodemodeSourceOptions,
  type CodemodeStoreWrites,
  type CodemodeTool,
  type ParsedCodemodeSource,
} from '@earendil-works/pi-codemode';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  NestedToolCallRecord,
  NestedToolRunner,
  ToolExecution,
} from '../../../loop/types';
import type { ToolStore } from '../../store';
import { toInputJsonSchema } from '../../support/input-schema';

import type { ContentPart } from '@scream-code/ltod';

/** Model-facing tool name. */
export const SCRIPT_TOOL_NAME = 'RunScript';

/** Declaration budget for the tool description (≈3000 tokens at 4 chars/token). */
const DECLARATION_BUDGET_CHARS = 12_000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

/** QuickJS heap ceiling per execution. */
const SANDBOX_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Nested-call *recording* caps, mirroring the reference runner: a call always
 * runs — only its record degrades. Arguments are dropped from the record once
 * the byte budgets are exhausted, and records stop once the call cap is hit.
 */
const MAX_NESTED_CALLS = 256;
const MAX_NESTED_ARG_BYTES = 8 * 1024;
const MAX_NESTED_TOTAL_ARG_BYTES = 32 * 1024;
const MAX_NESTED_MESSAGE_CHARS = 500;
const ARGS_PREVIEW_CHARS = 160;

const SCRIPT_PREAMBLE = [
  'Run JavaScript in a sandbox whose only capability is calling the tools listed below.',
  'The tool calls the script makes never enter the conversation — only what the script',
  'returns through `text(...)` (and `console.*`) is shown.',
  '',
  'When to use: several tool calls can be planned up front — batch work across many',
  'files, chained steps that need no decision in between, or filtering/aggregating',
  'results before reporting them.',
  'When not to use: a single tool call is enough, or each next step depends on',
  'observing the previous result.',
  '',
  'Rules:',
  '- Call tools as `await tools.<Name>({...})`; calls are auto-awaited and resolve to the',
  "  tool's text output. A failing call rejects with an Error carrying the failure text.",
  '- `store(key, value)` / `load(key)` persist small JSON values across turns (only successful runs commit writes).',
  '- `image(dataUrlOrBytes)` attaches an image to the result.',
  '- `exit()` ends the script early.',
  '- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`.',
].join('\n');

export const ScriptInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'JavaScript to run. Call the available tools as `tools.<Name>(args)`; only text()/console output reaches the conversation.',
    ),
});
export type ScriptInput = z.infer<typeof ScriptInputSchema>;

/** Builds the tool description including declarations for the callable tools. */
export function buildScriptToolDescription(callableTools: readonly ExecutableTool[]): string {
  if (callableTools.length === 0) {
    return `${SCRIPT_PREAMBLE}\n\nNo tools are currently available inside the script.`;
  }
  const declarations = renderDeclarations({
    tools: callableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      // Declarations only render signatures; the sandbox receives its own
      // tool table with real execute handlers.
      execute: (): undefined => undefined,
    })),
  });
  const full = `${SCRIPT_PREAMBLE}\n\nTool declarations:\n\n${declarations}`;
  if (full.length <= DECLARATION_BUDGET_CHARS) {
    return full;
  }
  const names = callableTools
    .map((tool) => `- ${tool.name}: ${firstLineOf(tool.description)}`)
    .join('\n');
  return [
    SCRIPT_PREAMBLE,
    '',
    `Tool declarations omitted (${callableTools.length} tools exceed the ${DECLARATION_BUDGET_CHARS}-character budget); call them by their exact names:`,
    names,
  ].join('\n');
}

/**
 * Runs model-written JavaScript in a QuickJS sandbox (worker thread) with the
 * current step's tools exposed as `tools.<Name>()`. Only the script's own
 * output enters the conversation; every nested call goes through the regular
 * tool pipeline (validation, hooks, approval) via `ctx.runNestedToolCall`.
 */
export class ScriptTool implements BuiltinTool<ScriptInput> {
  readonly name = SCRIPT_TOOL_NAME;
  readonly description = buildScriptToolDescription([]);
  readonly parameters = toInputJsonSchema(ScriptInputSchema);

  constructor(private readonly store: ToolStore) {}

  resolveExecution(args: ScriptInput): ToolExecution {
    let parsed: ParsedCodemodeSource | undefined;
    let parseError: string | undefined;
    try {
      parsed = parseCodemodeSource(args.code);
    } catch (error) {
      parseError =
        error instanceof CodemodeSourceError ? error.message : String(error);
    }
    return {
      description: 'Running a script',
      approvalRule: this.name,
      execute: async (ctx) => {
        if (parsed === undefined) {
          return {
            output: `Script rejected: ${parseError ?? 'invalid source'}`,
            isError: true,
          };
        }
        return this.run(parsed, ctx);
      },
    };
  }

  private async run(
    parsed: ParsedCodemodeSource,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const runner = ctx.runNestedToolCall;
    if (runner === undefined) {
      return {
        output:
          'RunScript is unavailable in this context: nested tool calls are not supported here.',
        isError: true,
      };
    }

    const state: NestedRunState = { calls: 0, argBytes: 0, records: [] };
    const sandbox = new CodemodeSandbox({
      tools: runner.tools.map((tool) => this.toSandboxTool(tool, runner, ctx, state)),
      memoryLimitBytes: SANDBOX_MEMORY_LIMIT_BYTES,
      // No implicit deadline (matching the reference implementation): the
      // script ends when it settles, the caller aborts, or `timeout_ms` fires.
      timeoutMs: parsed.options.timeoutMs ?? Number.POSITIVE_INFINITY,
    });
    try {
      const result = await sandbox.execute(parsed.code, {
        signal: ctx.signal,
        store: this.store.get('scriptStore') ?? {},
      });
      if (!result.ok) {
        return await this.failedResult(result.error, result.output, state);
      }
      this.commitStoreWrites(result.storeWrites);
      return await this.successResult(result.output, result.value, state, parsed.options);
    } finally {
      await sandbox.close();
    }
  }

  private toSandboxTool(
    tool: ExecutableTool,
    runner: NestedToolRunner,
    ctx: ExecutableToolContext,
    state: NestedRunState,
  ): CodemodeTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      execute: (args) => this.runNested(runner, tool.name, args, ctx, state),
    };
  }

  private async runNested(
    runner: NestedToolRunner,
    name: string,
    args: unknown,
    ctx: ExecutableToolContext,
    state: NestedRunState,
  ): Promise<unknown> {
    state.calls += 1;
    const callId = `${ctx.toolCallId}/${state.calls}`;

    // Recording caps: the call always runs; only the record degrades. `args`
    // may not be JSON-serializable here — the pipeline's own validation is the
    // authority on that, so the record simply goes incomplete.
    let record: NestedToolCallRecord | undefined;
    if (state.records.length < MAX_NESTED_CALLS) {
      const serialized = tryStringify(args);
      const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
      const overBudget =
        serialized === undefined ||
        bytes > MAX_NESTED_ARG_BYTES ||
        state.argBytes + bytes > MAX_NESTED_TOTAL_ARG_BYTES;
      record = {
        callId,
        name,
        status: 'ok',
        durationMs: 0,
        ...(overBudget ? { incomplete: true } : { argsPreview: previewOf(serialized) }),
      };
      if (!overBudget) {
        state.argBytes += bytes;
      }
      state.records.push(record);
    }

    const startedAt = Date.now();
    try {
      const result = await runner.run({ name, args, callId });
      if (record !== undefined) {
        record.status = result.isError === true ? 'error' : 'ok';
        record.durationMs = Date.now() - startedAt;
      }
      return resolveNestedValue(name, result);
    } catch (error) {
      if (record !== undefined) {
        record.status = 'error';
        record.durationMs = Date.now() - startedAt;
      }
      throw error;
    }
  }

  private commitStoreWrites(writes: CodemodeStoreWrites): void {
    const next: Record<string, unknown> = { ...this.store.get('scriptStore') };
    for (const [key, value] of Object.entries(writes.set)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    for (const key of writes.delete) {
      delete next[key];
    }
    this.store.set('scriptStore', next);
  }

  private async successResult(
    output: readonly CodemodeOutputItem[],
    value: unknown,
    state: NestedRunState,
    options: CodemodeSourceOptions,
  ): Promise<ExecutableToolResult> {
    const textParts = output
      .filter((item): item is Extract<CodemodeOutputItem, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text);
    if (value !== undefined) {
      textParts.push(valueText(value));
    }
    const { shown } = await truncateOutput(
      textParts.join('\n'),
      (options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * CHARS_PER_TOKEN,
    );
    const parts: ContentPart[] = [];
    if (shown.length > 0) {
      parts.push({ type: 'text', text: shown });
    }
    for (const item of output) {
      if (item.type === 'image') {
        parts.push({
          type: 'image_url',
          imageUrl: { url: `data:${item.mimeType};base64,${item.data}` },
        });
      }
    }
    if (parts.length === 0) {
      parts.push({ type: 'text', text: '(script produced no output)' });
    }
    return {
      output: parts,
      ...(state.records.length > 0 ? { nestedCalls: state.records } : {}),
    };
  }

  private async failedResult(
    error: CodemodeError,
    output: readonly CodemodeOutputItem[],
    state: NestedRunState,
  ): Promise<ExecutableToolResult> {
    const lines = [`Script failed (${error.kind}): ${error.message}`];
    // The sandbox keeps the output produced up to the failure (mirroring the
    // reference runner) — surfacing it tells the model how far the script got
    // instead of forcing a blind re-run.
    const partial = output
      .filter((item): item is Extract<CodemodeOutputItem, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (partial.length > 0) {
      const { shown } = await truncateOutput(
        partial,
        DEFAULT_MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN,
      );
      lines.push('', 'Partial output before the failure:', shown);
    }
    if (state.records.length > 0) {
      lines.push(
        `(${state.records.length} nested call${state.records.length === 1 ? '' : 's'} ran before the failure)`,
      );
    }
    return { output: lines.join('\n'), isError: true };
  }
}

interface NestedRunState {
  calls: number;
  argBytes: number;
  records: NestedToolCallRecord[];
}

/**
 * Provider-facing results resolve to their text for scripts; failures reject
 * with an Error so scripts can try/catch (mirroring the reference runner).
 */
function resolveNestedValue(name: string, result: ExecutableToolResult): string {
  const text =
    typeof result.output === 'string'
      ? result.output
      : result.output
          .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
  if (result.isError === true) {
    const detail = [result.message, text]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n');
    throw new Error(
      truncateChars(detail.length > 0 ? detail : `Tool "${name}" failed`, MAX_NESTED_MESSAGE_CHARS),
    );
  }
  return text;
}

/** Renders a script's returned value as text (string as-is, everything else JSON). */
function valueText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Truncates to the character budget, keeping half the budget on each side
 * (matching the reference implementation). The full text is spilled to a
 * temp file and its path reported in the shown output.
 */
async function truncateOutput(text: string, maxChars: number): Promise<{ shown: string }> {
  if (text.length <= maxChars) {
    return { shown: text };
  }
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  const removedChars = text.length - headChars - tailChars;
  const path = join(tmpdir(), `scream-script-output-${randomBytes(6).toString('hex')}.txt`);
  let spillNote: string;
  try {
    await writeFile(path, text, 'utf8');
    spillNote = `[Full output: ${path}]`;
  } catch (error) {
    spillNote = `[Could not save the full output: ${String(error)}]`;
  }
  return {
    shown: [
      `Warning: truncated output (original token count: ${Math.ceil(text.length / CHARS_PER_TOKEN)})`,
      `Total output lines: ${text.split('\n').length}`,
      '',
      // `slice(-0)` returns the *whole* string, so a zero-sized tail (e.g.
      // `max_output_tokens: 0`) must be skipped explicitly — otherwise the
      // "truncated" result would embed the full untruncated output.
      ...(headChars > 0 ? [text.slice(0, headChars)] : []),
      `… (${Math.ceil(removedChars / CHARS_PER_TOKEN)} tokens truncated) …`,
      ...(tailChars > 0 ? [text.slice(-tailChars)] : []),
      '',
      spillNote,
    ].join('\n'),
  };
}

function tryStringify(args: unknown): string | undefined {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return undefined;
  }
}

function previewOf(serialized: string | undefined): string {
  return truncateChars((serialized ?? '').replaceAll('\n', ' '), ARGS_PREVIEW_CHARS);
}

function truncateChars(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function firstLineOf(description: string): string {
  const line = description.split('\n', 1)[0] ?? '';
  return truncateChars(line, 120);
}
