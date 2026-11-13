/**
 * DebugTool — an interactive Python debugger session over DAP.
 *
 * One session per tool instance (agent-scoped): `launch` or `attach` opens it,
 * `disconnect` closes it, and every other operation applies to the open
 * session. The tool is deliberately output-oriented and terse: a stop is
 * reported as a status line plus the top frame, frames as
 * `#0 main at file:line (id N)`, and variables as `name = value (type)` with a
 * `(ref N)` marker for children. Nothing here interprets the program — the
 * model inspects and decides.
 *
 * The adapter is debugpy, resolved once per session (see `dap/adapter.ts`);
 * a missing install is reported as an install instruction, never as a raw
 * spawn error. The adapter process is spawned like an LSP server (same framing
 * util, same owner-record supervisor), so it is reaped with the session.
 */

import type { Jian } from '@scream-code/jian';
import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import {
  buildLaunchSpec,
  resolveDebugpy,
  type DebugAdapterResolution,
  type ResolvedDebugAdapter,
} from '../../dap/adapter';
import {
  DapAbortedError,
  DapClient,
  type DapBreakpoint,
  type DapStackFrame,
  type DapVariable,
} from '../../dap/client';
import type { LspProcessSupervisor } from '../../lsp/process-supervisor';
import { ToolAccesses } from '../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../loop/types';
import { isParentInterject } from '../../utils/abort';
import { commandApprovalRule, matchesCommandRule } from '../support/command-rule';
import { toInputJsonSchema } from '../support/input-schema';
import DEBUG_DESCRIPTION from './debug.md';

// ── Limits ───────────────────────────────────────────────────────────

/** How long a stop wait may block, in seconds (schema bound). */
export const DEBUG_DEFAULT_WAIT_SECONDS = 5;
export const DEBUG_MAX_WAIT_SECONDS = 60;

/** Listing caps so one result cannot flood the context. */
const MAX_LISTED_FRAMES = 20;
const MAX_LISTED_VARIABLES = 100;
const MAX_LINE_CHARS = 160;
const MAX_PROGRAM_OUTPUT_LINES = 20;
/** Recent debuggee stdout/stderr kept for snapshots, in characters. */
const OUTPUT_TAIL_CHARS = 8 * 1024;

// ── Input schema ─────────────────────────────────────────────────────

export const DebugBreakpointGroupSchema = z.object({
  path: z.string().describe('Python file the breakpoints belong to.'),
  lines: z
    .array(z.number().int().min(1))
    .min(1)
    .describe('1-based line numbers to stop at.'),
});

export type DebugBreakpointGroup = z.infer<typeof DebugBreakpointGroupSchema>;

export const DebugInputSchema = z.object({
  operation: z
    .enum([
      'launch',
      'attach',
      'set_breakpoints',
      'continue',
      'stack_trace',
      'scopes',
      'variables',
      'evaluate',
      'disconnect',
    ])
    .describe(
      "Debug operation: 'launch' (start a program under the debugger), 'attach' (connect to a debugpy listener), 'set_breakpoints', 'continue', 'stack_trace', 'scopes', 'variables', 'evaluate', or 'disconnect'.",
    ),
  program: z
    .string()
    .optional()
    .describe("For 'launch': the Python file to debug. Relative paths resolve against the working directory."),
  args: z.array(z.string()).optional().describe("For 'launch': command-line arguments passed to the program."),
  stop_on_entry: z
    .boolean()
    .optional()
    .describe("For 'launch': stop on the program's first line (default true)."),
  breakpoints: z
    .array(DebugBreakpointGroupSchema)
    .optional()
    .describe(
      "For 'launch'/'attach': breakpoints to set before the debuggee starts, so the program does not run past them.",
    ),
  path: z.string().optional().describe("For 'set_breakpoints': the file to set breakpoints in."),
  lines: z
    .array(z.number().int().min(1))
    .optional()
    .describe("For 'set_breakpoints': 1-based line numbers to stop at."),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("For 'attach': port of a debuggee already listening for a DAP client on 127.0.0.1."),
  thread_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Thread for 'continue'/'stack_trace' (defaults to the last stopped thread)."),
  frame_id: z
    .number()
    .int()
    .optional()
    .describe("Frame for 'scopes'/'evaluate' (defaults to the top frame of the last stop)."),
  variables_reference: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("For 'variables': the reference a scope or parent variable reported."),
  expression: z.string().optional().describe("For 'evaluate': the expression to evaluate in the stopped frame."),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(DEBUG_MAX_WAIT_SECONDS)
    .default(DEBUG_DEFAULT_WAIT_SECONDS)
    .optional()
    .describe(
      `How long 'launch'/'attach'/'continue' wait for a stop (default ${String(DEBUG_DEFAULT_WAIT_SECONDS)}, at most ${String(DEBUG_MAX_WAIT_SECONDS)}). A timeout reports the program as running, not as an error.`,
    ),
});

export type DebugInput = z.infer<typeof DebugInputSchema>;

// ── Session state ────────────────────────────────────────────────────

/**
 * Recent debuggee output, capped by character count (code units, not bytes —
 * a CJK-heavy program keeps fewer visible characters than a pure ASCII one)
 * so a chatty program stays cheap.
 */
class OutputTail {
  private text = '';

  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-OUTPUT_TAIL_CHARS);
  }

  tail(maxLines: number): string[] {
    if (this.text.length === 0) return [];
    const lines = this.text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-maxLines);
  }
}

interface DebugSession {
  readonly client: DapClient;
  readonly output: OutputTail;
  readonly exitCode: () => number | undefined;
  /** Thread of the last stop, reused by continue / stack_trace. */
  threadId: number | undefined;
  /** Top frame of the last stop, reused by scopes / evaluate. */
  frameId: number | undefined;
}

export interface DebugToolOptions {
  /**
   * Test seam: replace the debugpy probe with a fixed adapter description.
   * Production construction leaves it unset and probes `python3 -m debugpy`.
   */
  readonly resolveAdapter?: ((jian: Jian) => Promise<DebugAdapterResolution>) | undefined;
  readonly pythonCommand?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

// ── Implementation ───────────────────────────────────────────────────

function truncateLine(text: string, max = MAX_LINE_CHARS): string {
  const single = text.replaceAll(/[\r\n]+/g, ' ');
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** `#0 main at /tmp/prog.py:3 (id 1)` — index for humans, id for follow-ups. */
function formatFrame(frame: DapStackFrame, index: number): string {
  const location = frame.sourcePath ?? frame.sourceName ?? '<unknown source>';
  return `#${String(index)} ${frame.name} at ${location}:${String(frame.line)} (id ${String(frame.id)})`;
}

function formatVariable(variable: DapVariable): string {
  const type = variable.type !== undefined && variable.type.length > 0 ? ` (${variable.type})` : '';
  const children = variable.variablesReference > 0 ? ` (ref ${String(variable.variablesReference)})` : '';
  return truncateLine(`${variable.name} = ${variable.value}${type}${children}`);
}

/** Per-line breakpoint report; DAP answers in request order. */
function formatBreakpointReport(
  path: string,
  lines: readonly number[],
  reported: readonly DapBreakpoint[],
): string[] {
  return lines.map((line, index) => {
    const entry = reported[index];
    const verified = entry?.verified === true;
    const suffix =
      !verified && entry?.message !== undefined && entry.message.length > 0
        ? ` — ${truncateLine(entry.message)}`
        : '';
    return `${path}:${String(line)} ${verified ? 'verified' : 'unverified'}${suffix}`;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every operation that needs a live session returns this when there is none. */
const NO_SESSION_RESULT: ExecutableToolResult = {
  isError: true,
  output: 'No debug session is open; call launch or attach first.',
};

function abortedResult(signal: AbortSignal): ExecutableToolResult {
  const who = isParentInterject(signal.reason) ? 'the parent agent' : 'user';
  return { isError: true, output: `Debug interrupted by ${who}.` };
}

/** The action an approval rule is recorded against (Bash-style subject). */
function debugSubject(args: DebugInput): string {
  switch (args.operation) {
    case 'launch':
      return `launch ${args.program ?? ''}`.trim();
    case 'attach':
      return `attach ${String(args.port ?? '')}`.trim();
    case 'set_breakpoints':
      return `set_breakpoints ${args.path ?? ''}`.trim();
    case 'evaluate':
      return `evaluate ${args.expression ?? ''}`.trim();
    case 'continue':
    case 'disconnect':
    case 'scopes':
    case 'stack_trace':
    case 'variables':
      return args.operation;
  }
}

function debugCallDescription(args: DebugInput): string {
  switch (args.operation) {
    case 'launch':
      return `Debugging: launch ${args.program ?? ''}`.trim();
    case 'attach':
      return `Debugging: attach to port ${String(args.port ?? '?')}`;
    case 'set_breakpoints':
      return `Debugging: set breakpoints in ${args.path ?? ''}`.trim();
    case 'continue':
      return 'Debugging: continue';
    case 'stack_trace':
      return 'Debugging: stack trace';
    case 'scopes':
      return 'Debugging: scopes';
    case 'variables':
      return 'Debugging: variables';
    case 'evaluate':
      return `Debugging: evaluate ${args.expression ?? ''}`.trim();
    case 'disconnect':
      return 'Debugging: disconnect';
  }
}

export class DebugTool implements BuiltinTool<DebugInput> {
  readonly name = 'Debug';
  readonly description: string = DEBUG_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(DebugInputSchema);

  private session: DebugSession | undefined;
  /** Successful adapter resolution, reused for the whole session. */
  private adapter: ResolvedDebugAdapter | undefined;

  constructor(
    private readonly jian: Jian,
    private readonly cwd: string,
    private readonly supervisor?: LspProcessSupervisor | undefined,
    private readonly options: DebugToolOptions = {},
  ) {}

  resolveExecution(args: DebugInput): ToolExecution {
    const subject = debugSubject(args);
    return {
      description: debugCallDescription(args),
      // A debugger spawns and controls a whole process tree: claims everything,
      // like any other tool that runs arbitrary code.
      accesses: ToolAccesses.all(),
      approvalRule: commandApprovalRule(this.name, subject),
      matchesRule: (ruleArgs) => matchesCommandRule(ruleArgs, subject),
      execute: (ctx) => this.execute(args, ctx),
    };
  }

  private async execute(
    args: DebugInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (ctx.signal.aborted) return abortedResult(ctx.signal);
    try {
      switch (args.operation) {
        case 'launch':
          return await this.launch(args, ctx);
        case 'attach':
          return await this.attach(args, ctx);
        case 'set_breakpoints':
          return await this.setBreakpoints(args);
        case 'continue':
          return await this.continueExecution(args, ctx);
        case 'stack_trace':
          return await this.stackTrace(args);
        case 'scopes':
          return await this.scopes(args);
        case 'variables':
          return await this.variables(args);
        case 'evaluate':
          return await this.evaluate(args);
        case 'disconnect':
          return await this.disconnect();
      }
    } catch (error) {
      if (error instanceof DapAbortedError) {
        // An interrupted wait must not leave a half-controlled debuggee behind.
        await this.closeSession();
        return abortedResult(ctx.signal);
      }
      return { isError: true, output: `Debug ${args.operation} failed: ${errorMessage(error)}` };
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────

  private async launch(
    args: DebugInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (this.session !== undefined) {
      return {
        isError: true,
        output:
          'A debug session is already open; disconnect it before launching another program.',
      };
    }
    const program = args.program?.trim() ?? '';
    if (program.length === 0) {
      return { isError: true, output: "'launch' requires 'program' (the Python file to debug)." };
    }
    const invalidBreakpoints = this.validateBreakpoints(args.breakpoints);
    if (invalidBreakpoints !== undefined) return invalidBreakpoints;
    const resolution = await this.resolveAdapter();
    if (!resolution.ok) return { isError: true, output: resolution.reason };

    const { session, client } = this.createSession(resolution);
    try {
      await client.start();
      await client.initialize();
      client.launch(
        buildLaunchSpec({
          python: resolution.python,
          program: this.absolutePath(program),
          args: args.args ?? [],
          cwd: this.cwd,
          stopOnEntry: args.stop_on_entry ?? true,
        }),
      );
      const breakpoints = await this.applyBreakpoints(client, args.breakpoints);
      await client.configurationDone();
      this.session = session;
      return await this.snapshot(session, args.timeout_seconds, ctx, breakpoints);
    } catch (error) {
      await client.dispose();
      if (error instanceof DapAbortedError) return abortedResult(ctx.signal);
      return { isError: true, output: this.failure('launch', error, client) };
    }
  }

  private async attach(
    args: DebugInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (this.session !== undefined) {
      return {
        isError: true,
        output: 'A debug session is already open; disconnect it before attaching to another process.',
      };
    }
    if (args.port === undefined) {
      return { isError: true, output: "'attach' requires 'port'." };
    }
    const invalidBreakpoints = this.validateBreakpoints(args.breakpoints);
    if (invalidBreakpoints !== undefined) return invalidBreakpoints;
    const resolution = await this.resolveAdapter();
    if (!resolution.ok) return { isError: true, output: resolution.reason };

    const { session, client } = this.createSession(resolution);
    try {
      await client.start();
      await client.initialize();
      await client.attach(args.port);
      const breakpoints = await this.applyBreakpoints(client, args.breakpoints);
      await client.configurationDone();
      this.session = session;
      return await this.snapshot(session, args.timeout_seconds, ctx, breakpoints);
    } catch (error) {
      await client.dispose();
      if (error instanceof DapAbortedError) return abortedResult(ctx.signal);
      return { isError: true, output: this.failure('attach', error, client) };
    }
  }

  private async disconnect(): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) {
      return { isError: false, output: 'No debug session is open.' };
    }
    this.session = undefined;
    try {
      await session.client.disconnect();
    } catch (error) {
      return { isError: true, output: `Debugger disconnect failed: ${errorMessage(error)}` };
    }
    return {
      isError: false,
      output: 'Debug session closed; the adapter and the debuggee were terminated.',
    };
  }

  private async closeSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) await session.client.dispose();
  }

  private createSession(resolution: ResolvedDebugAdapter): {
    readonly session: DebugSession;
    readonly client: DapClient;
  } {
    const output = new OutputTail();
    const state: { exitCode: number | undefined } = { exitCode: undefined };
    const client = new DapClient({
      jian: this.jian,
      command: [...resolution.command, ...resolution.args],
      workspaceRoot: this.cwd,
      supervisor: this.supervisor,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    client.onEvent((event) => {
      if (event.event === 'output') {
        const text = event.body['output'];
        if (typeof text === 'string') output.push(text);
      } else if (event.event === 'exited') {
        const code = event.body['exitCode'];
        if (typeof code === 'number') state.exitCode = code;
      }
    });
    const session: DebugSession = {
      client,
      output,
      exitCode: () => state.exitCode,
      threadId: undefined,
      frameId: undefined,
    };
    return { session, client };
  }

  private async resolveAdapter(): Promise<DebugAdapterResolution> {
    if (this.adapter !== undefined) return this.adapter;
    const resolution =
      this.options.resolveAdapter !== undefined
        ? await this.options.resolveAdapter(this.jian)
        : await resolveDebugpy(this.jian, this.options.pythonCommand);
    // Only a success is cached: a failed probe is retried on the next launch so
    // installing debugpy mid-session is picked up without restarting.
    if (resolution.ok) this.adapter = resolution;
    return resolution;
  }

  // ── Operations on an open session ────────────────────────────────

  private async setBreakpoints(args: DebugInput): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) return NO_SESSION_RESULT;
    if (args.path === undefined || args.path.trim().length === 0) {
      return { isError: true, output: "'set_breakpoints' requires 'path'." };
    }
    if (args.lines === undefined || args.lines.length === 0) {
      return { isError: true, output: "'set_breakpoints' requires at least one line in 'lines'." };
    }
    const path = this.absolutePath(args.path);
    const reported = await session.client.setBreakpoints(path, args.lines);
    const lines = formatBreakpointReport(path, args.lines, reported);
    return {
      isError: false,
      output: [`Breakpoints in ${path}:`, ...lines.map((line) => `  ${line}`)].join('\n'),
    };
  }

  private async continueExecution(
    args: DebugInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) return NO_SESSION_RESULT;
    const threadId = args.thread_id ?? session.threadId;
    if (threadId === undefined) {
      return {
        isError: true,
        output:
          'No stopped thread is known yet; pass thread_id, or call stack_trace after the program stops.',
      };
    }
    await session.client.continue_(threadId);
    return this.snapshot(session, args.timeout_seconds, ctx);
  }

  private async stackTrace(args: DebugInput): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) return NO_SESSION_RESULT;
    const threadId = args.thread_id ?? session.threadId;
    if (threadId === undefined) {
      return {
        isError: true,
        output:
          'No stopped thread is known yet; pass thread_id, or call stack_trace after the program stops.',
      };
    }
    const frames = await session.client.stackTrace(threadId, MAX_LISTED_FRAMES + 1);
    if (frames.length === 0) {
      return { isError: false, output: `Thread ${String(threadId)} has no stack frames.` };
    }
    session.frameId = frames[0]?.id;
    const listed = frames.slice(0, MAX_LISTED_FRAMES).map((frame, index) => formatFrame(frame, index));
    if (frames.length > MAX_LISTED_FRAMES) {
      listed.push(`… and ${String(frames.length - MAX_LISTED_FRAMES)} more frame(s)`);
    }
    return {
      isError: false,
      output: [`Thread ${String(threadId)} stack (${String(frames.length)} frame(s)):`, '', ...listed].join(
        '\n',
      ),
    };
  }

  private async scopes(args: DebugInput): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) return NO_SESSION_RESULT;
    const frameId = args.frame_id ?? session.frameId;
    if (frameId === undefined) {
      return {
        isError: true,
        output: 'No frame is known yet; call stack_trace first, or pass frame_id.',
      };
    }
    const scopes = await session.client.scopes(frameId);
    if (scopes.length === 0) {
      return { isError: false, output: `Frame ${String(frameId)} has no scopes.` };
    }
    const listed = scopes.map(
      (scope) =>
        `${scope.name} — variables_reference ${String(scope.variablesReference)}${scope.expensive ? ' (expensive)' : ''}`,
    );
    return {
      isError: false,
      output: [`Scopes of frame ${String(frameId)}:`, ...listed.map((line) => `  ${line}`)].join('\n'),
    };
  }

  private async variables(args: DebugInput): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) return NO_SESSION_RESULT;
    const reference = args.variables_reference;
    if (reference === undefined) {
      return {
        isError: true,
        output: "'variables' requires 'variables_reference' (from scopes or a parent variable).",
      };
    }
    const variables = await session.client.variables(reference);
    if (variables.length === 0) {
      return { isError: false, output: `Reference ${String(reference)} has no variables.` };
    }
    const listed = variables
      .slice(0, MAX_LISTED_VARIABLES)
      .map((variable) => formatVariable(variable));
    if (variables.length > MAX_LISTED_VARIABLES) {
      listed.push(`… and ${String(variables.length - MAX_LISTED_VARIABLES)} more variable(s)`);
    }
    return {
      isError: false,
      output: [`Variables (${String(variables.length)}):`, ...listed.map((line) => `  ${line}`)].join(
        '\n',
      ),
    };
  }

  private async evaluate(args: DebugInput): Promise<ExecutableToolResult> {
    const session = this.session;
    if (session === undefined) return NO_SESSION_RESULT;
    const expression = args.expression?.trim() ?? '';
    if (expression.length === 0) {
      return { isError: true, output: "'evaluate' requires 'expression'." };
    }
    const frameId = args.frame_id ?? session.frameId;
    const evaluation = await session.client.evaluate(expression, frameId);
    const result = evaluation.result.length > 0 ? evaluation.result : '(empty result)';
    const type = evaluation.type !== undefined && evaluation.type.length > 0 ? evaluation.type : undefined;
    return {
      isError: false,
      output: truncateLine(type !== undefined ? `${result} (${type})` : result),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private validateBreakpoints(
    groups: readonly DebugBreakpointGroup[] | undefined,
  ): ExecutableToolResult | undefined {
    if (groups === undefined) return undefined;
    for (const group of groups) {
      if (group.path.trim().length === 0 || group.lines.length === 0) {
        return {
          isError: true,
          output: "Each entry of 'breakpoints' needs a 'path' and at least one line.",
        };
      }
    }
    return undefined;
  }

  private async applyBreakpoints(
    client: DapClient,
    groups: readonly DebugBreakpointGroup[] | undefined,
  ): Promise<string[]> {
    if (groups === undefined || groups.length === 0) return [];
    const lines: string[] = [];
    for (const group of groups) {
      const path = this.absolutePath(group.path);
      const reported = await client.setBreakpoints(path, group.lines);
      lines.push(...formatBreakpointReport(path, group.lines, reported));
    }
    return lines;
  }

  /**
   * Wait for the next stop / termination and render it. Timeouts are normal
   * (`status: running`): the session stays open, the model can wait again or
   * inspect later.
   */
  private async snapshot(
    session: DebugSession,
    timeoutSeconds: number | undefined,
    ctx: ExecutableToolContext,
    breakpoints?: readonly string[],
  ): Promise<ExecutableToolResult> {
    const seconds = Math.min(
      Math.max(1, timeoutSeconds ?? DEBUG_DEFAULT_WAIT_SECONDS),
      DEBUG_MAX_WAIT_SECONDS,
    );
    const event = await session.client.waitForEvent(['stopped', 'terminated'], seconds * 1000, ctx.signal);
    const lines: string[] = [];

    if (event === undefined) {
      lines.push(
        'status: running',
        `No stop event within ${String(seconds)}s; the debuggee is still running.`,
      );
    } else if (event.event === 'terminated') {
      const code = session.exitCode();
      lines.push(`status: terminated${code !== undefined ? ` (exit code ${String(code)})` : ''}`);
      // The debuggee is gone; release the adapter so no process lingers.
      if (this.session === session) this.session = undefined;
      await session.client.disconnect();
    } else {
      const reason = typeof event.body['reason'] === 'string' ? event.body['reason'] : 'unknown';
      const threadId =
        typeof event.body['threadId'] === 'number' ? event.body['threadId'] : session.threadId;
      if (threadId !== undefined) session.threadId = threadId;
      lines.push('status: stopped', `reason: ${reason}`);
      if (threadId !== undefined) lines.push(`thread: ${String(threadId)}`);
      const topFrame = await this.describeTopFrame(session, threadId);
      if (topFrame !== undefined) lines.push(`frame: ${topFrame}`);
    }

    if (breakpoints !== undefined && breakpoints.length > 0) {
      lines.push('', 'breakpoints:', ...breakpoints.map((line) => `  ${line}`));
    }
    const tail = session.output.tail(MAX_PROGRAM_OUTPUT_LINES);
    if (tail.length > 0) {
      lines.push('', 'output:', ...tail.map((line) => `  ${truncateLine(line)}`));
    }
    return { isError: false, output: lines.join('\n') };
  }

  /** `#0 main at file:line (id N)` for the top frame, or undefined if unknown. */
  private async describeTopFrame(
    session: DebugSession,
    threadId: number | undefined,
  ): Promise<string | undefined> {
    if (threadId === undefined) return undefined;
    try {
      const frames = await session.client.stackTrace(threadId, 1);
      const frame = frames[0];
      if (frame === undefined) return undefined;
      session.frameId = frame.id;
      return formatFrame(frame, 0);
    } catch {
      // A stack trace is a nicety, not a reason to fail the stop report.
      return undefined;
    }
  }

  private failure(operation: string, error: unknown, client: DapClient): string {
    const detail = errorMessage(error);
    const stderr = client.stderrOutput;
    return stderr.length > 0
      ? `Debug ${operation} failed: ${detail}\nAdapter stderr:\n${stderr}`
      : `Debug ${operation} failed: ${detail}`;
  }

  /** Resolve a path against the working directory (DAP wants absolute paths). */
  private absolutePath(path: string): string {
    const normalized = this.jian.normpath(path);
    const isAbsolute =
      this.jian.pathClass() === 'win32'
        ? /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\')
        : normalized.startsWith('/');
    if (isAbsolute) return normalized;
    const separator = this.jian.pathClass() === 'win32' ? '\\' : '/';
    return this.jian.normpath(`${this.cwd}${separator}${normalized}`);
  }
}
