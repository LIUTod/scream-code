/**
 * Fusion plan worker orchestration.
 *
 * Spawns multiple `scream` CLI subagents in headless JSON mode to produce
 * parallel implementation plans, then synthesizes them into a single plan.
 *
 * This is intentionally a TUI-layer strategy: agent-core still sees a plain
 * boolean plan mode, and the synthesized plan is injected into the normal
 * plan file before the agent takes over.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MAIN_TS = resolve(APP_ROOT, 'src/main.ts');
const MAIN_MJS = resolve(APP_ROOT, 'dist/main.mjs');
const RAW_TEXT_LOADER = resolve(APP_ROOT, '../../build/register-raw-text-loader.mjs');

function tsxCommand(): string {
  return process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
}

function buildSourceCommand(): { command: string; prefixArgs: string[] } {
  const prefixArgs = existsSync(RAW_TEXT_LOADER)
    ? ['--import', RAW_TEXT_LOADER, MAIN_TS]
    : [MAIN_TS];
  return { command: tsxCommand(), prefixArgs };
}

function trySourceOrDist(): { command: string; prefixArgs: string[] } {
  if (existsSync(MAIN_TS)) return buildSourceCommand();
  if (existsSync(MAIN_MJS)) return { command: process.execPath, prefixArgs: [MAIN_MJS] };
  return { command: 'scream', prefixArgs: [] };
}

export const SCREAM_FUSIONPLAN_SUBAGENT_ENV = 'SCREAM_FUSIONPLAN_SUBAGENT';

/**
 * Terminate a child process tree reliably on both POSIX and Windows.
 * On Windows `proc.kill()` only signals the wrapper, so use `taskkill /T`.
 * On POSIX, kill the process group so grandchildren inherit the signal.
 */
function killProcessTree(proc: ReturnType<typeof spawn>, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') {
    const force = signal === 'SIGKILL' ? ['/F'] : [];
    const child = spawn('taskkill', [...force, '/T', '/PID', String(proc.pid)], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    });
    if (typeof child.unref === 'function') {
      child.unref();
    }
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* best effort */
    }
  }
}

export type FusionPlanPhase = 'planning' | 'synthesis' | 'completed' | 'failed';

export interface FusionPlanWorkerProgress {
  readonly index: number;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly angle: string;
  readonly label: string;
}

export interface FusionPlanProgressEvent {
  readonly phase: FusionPlanPhase;
  readonly completedWorkers: number;
  readonly totalWorkers: number;
  readonly failedWorkers: number;
  readonly workers: readonly FusionPlanWorkerProgress[];
}

export interface FusionPlanWorkerInput {
  readonly index: number;
  readonly task: string;
  readonly angle: string;
  readonly label: string;
  readonly cwd: string;
  readonly promptDir: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly screamBin?: string;
  readonly onStarted?: () => void;
}

export interface FusionPlanWorkerResult {
  ok: boolean;
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Timeout applied to this worker (ms), for diagnostics. */
  timeoutMs?: number;
  /** Resolved CLI invocation, for diagnostics. */
  command?: string;
}

export interface FusionPlanOptions {
  readonly task: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly workerCount?: number;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly synthesisMaxOutputBytes?: number;
  readonly screamBin?: string;
  readonly onProgress?: (event: FusionPlanProgressEvent) => void;
}

export interface FusionPlanResult {
  readonly ok: boolean;
  readonly plan: string;
  readonly workerResults: readonly FusionPlanWorkerResult[];
}


interface JsonMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly toolName?: string;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
  };
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

interface JsonEvent {
  readonly role?: string;
  readonly content?: unknown;
  readonly type?: string;
  readonly assistantMessageEvent?: {
    readonly type?: string;
    readonly delta?: string;
  };
  readonly toolName?: string;
  readonly args?: unknown;
  readonly message?: JsonMessage;
}

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

const DEFAULT_WORKER_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_000;
const DEFAULT_SYNTHESIS_MAX_OUTPUT_BYTES = 12_000;

/** Override via `SCREAM_FUSIONPLAN_TIMEOUT_SECONDS` env var (30..3600). */
function resolveDefaultTimeoutMs(): number {
  const env = process.env['SCREAM_FUSIONPLAN_TIMEOUT_SECONDS'];
  if (env === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(env, 10);
  if (Number.isNaN(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(30_000, Math.min(3_600_000, parsed * 1000));
}
function buildPlannerPrompt(input: { task: string; angle: string; maxOutputBytes: number }): string {
  return [
    'You are a planning specialist. Create an implementation plan for the request below.',
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
    'You are a senior engineer. Review the following plans from multiple planning specialists and synthesize them into a single optimal implementation plan.',
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

async function createPromptDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scream-fusionplan-'));
}

async function writePromptFile(dir: string, index: number, prompt: string): Promise<string> {
  const file = join(dir, `worker-${index}.md`);
  await writeFile(file, prompt, 'utf8');
  return file;
}

async function cleanupPromptDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function buildWorkerArgs(input: {
  promptFile: string;
  model?: string;
}): Promise<readonly string[]> {
  const prompt = await readFile(input.promptFile, 'utf8');
  const args: string[] = ['--output-format', 'stream-json', '--prompt', prompt];
  if (input.model) {
    args.push('--model', input.model);
  }
  return args;
}
export function resolveScreamCommand(screamBin?: string): { command: string; prefixArgs: string[] } {
  if (screamBin) {
    return { command: screamBin, prefixArgs: [] };
  }

  const entry = process.argv[1];
  if (!entry) {
    return trySourceOrDist();
  }

  const absoluteEntry = resolve(entry);

  // Dev wrapper: it spawns the real source CLI, so resolve to source/dist directly.
  if (/[\\/]scripts[\\/]dev\.mjs$/.test(absoluteEntry)) {
    return trySourceOrDist();
  }

  // Production build.
  if (absoluteEntry.endsWith('dist/main.mjs')) {
    return { command: process.execPath, prefixArgs: [absoluteEntry] };
  }

  // Source run under tsx (e.g. `tsx --import ... ./src/main.ts`).
  if (absoluteEntry.endsWith('src/main.ts')) {
    return buildSourceCommand();
  }

  // Generic built script fallback.
  if (absoluteEntry.endsWith('.mjs') || absoluteEntry.endsWith('.js')) {
    return { command: process.execPath, prefixArgs: [absoluteEntry] };
  }

  return trySourceOrDist();
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
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
async function runWorker(input: FusionPlanWorkerInput): Promise<FusionPlanWorkerResult> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const promptFile = await writePromptFile(
    input.promptDir,
    input.index,
    buildPlannerPrompt({
      task: input.task,
      angle: input.angle,
      maxOutputBytes,
    }),
  );
  const result: FusionPlanWorkerResult = {
    ok: false,
    output: '',
    stderr: '',
    exitCode: null,
    timedOut: false,
  };
  try {
    const args = await buildWorkerArgs({
      promptFile,
      model: input.model,
    });
    const { command, prefixArgs } = resolveScreamCommand(input.screamBin);
    const timeoutMs = input.timeoutMs ?? resolveDefaultTimeoutMs();
    const fullCommand = [command, ...prefixArgs, ...args].join(' ');
    result.command = fullCommand;

    const exitCode = await new Promise<number | null>((resolve) => {
      const proc = spawn(command, [...prefixArgs, ...args], {
        cwd: input.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, [SCREAM_FUSIONPLAN_SUBAGENT_ENV]: '1' },
      });
      input.onStarted?.();

      let stdoutBuffer = '';
      let timeout: NodeJS.Timeout | undefined;

      const processLine = (line: string): void => {
        if (!line.trim()) return;
        let event: JsonEvent;
        try {
          event = JSON.parse(line) as JsonEvent;
        } catch {
          return;
        }

        // scream --output-format stream-json emits flat assistant/tool JSON lines.
        if (event.role === 'assistant' && event.content) {
          const text = textFromContent(event.content).trim();
          if (text) {
            result.output += (result.output ? '\n\n' : '') + text;
          }
        }
      };

      proc.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      proc.stderr.on('data', (data: Buffer) => {
        result.stderr += data.toString('utf8');
      });

      let resolved = false;
      const safeResolve = (value: number | null): void => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      proc.on('error', (error: Error) => {
        result.stderr += error.message;
        safeResolve(null);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        safeResolve(code ?? 0);
      });

      timeout = setTimeout(() => {
        result.timedOut = true;
        killProcessTree(proc, 'SIGTERM');
        setTimeout(() => killProcessTree(proc, 'SIGKILL'), 5_000).unref();
      }, timeoutMs);
      timeout.unref();
    });

    result.exitCode = exitCode;
    result.timeoutMs = timeoutMs;
    result.ok = exitCode === 0 && !result.timedOut && result.output.trim().length > 0;
    if (!result.output.trim()) {
      result.output = result.stderr.trim() || '(worker produced no final assistant output)';
    }
    return result;
  } finally {
    await rm(promptFile, { force: true });
  }
}

async function runSynthesisWorker(
  input: {
    task: string;
    workerOutputs: readonly string[];
    cwd: string;
    model?: string;
    thinkingLevel?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    screamBin?: string;
  },
  promptDir: string,
): Promise<string> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_SYNTHESIS_MAX_OUTPUT_BYTES;
  const truncatedOutputs = input.workerOutputs.map((output) => truncateUtf8(output, maxOutputBytes));
  const prompt = buildSynthesisPrompt({
    task: input.task,
    workerOutputs: truncatedOutputs,
    maxOutputBytes,
  });
  const result = await runWorker({
    index: 0,
    task: prompt,
    angle: 'Synthesize the best plan from the specialist outputs.',
    label: '综合',
    cwd: input.cwd,
    promptDir,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    timeoutMs: input.timeoutMs,
    maxOutputBytes,
    screamBin: input.screamBin,
  });
  return result.ok ? result.output.trim() : `(synthesis failed: ${result.stderr || 'no output'})`;
}

function buildWorkerProgress(
  states: { status: 'pending' | 'running' | 'completed' | 'failed'; angle: string; label: string }[],
): FusionPlanWorkerProgress[] {
  return states.map((s, index) => ({
    index,
    status: s.status,
    angle: s.angle,
    label: s.label,
  }));
}

export async function runFusionPlan(input: FusionPlanOptions): Promise<FusionPlanResult> {
  // Prevent recursive fusion-plan execution inside worker subagents.
  if (process.env[SCREAM_FUSIONPLAN_SUBAGENT_ENV] === '1') {
    return { ok: false, plan: '', workerResults: [] };
  }

  const workerCount = Math.max(1, Math.min(8, input.workerCount ?? DEFAULT_WORKER_COUNT));
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = input.timeoutMs ?? resolveDefaultTimeoutMs();
  const promptDir = await createPromptDir();

  const workerStates: { status: 'pending' | 'running' | 'completed' | 'failed'; angle: string; label: string }[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    const angleDef = WORKER_ANGLES[i % WORKER_ANGLES.length]!;
    workerStates.push({ status: 'pending', angle: angleDef.angle, label: angleDef.label });
  }

  const emitProgress = (phase: FusionPlanPhase): void => {
    const completedWorkers = workerStates.filter((s) => s.status === 'completed').length;
    const failedWorkers = workerStates.filter((s) => s.status === 'failed').length;
    input.onProgress?.({
      phase,
      completedWorkers,
      totalWorkers: workerCount,
      failedWorkers,
      workers: buildWorkerProgress(workerStates),
    });
  };

  try {
    emitProgress('planning');

    const workerPromises = workerStates.map((state, index) =>
      runWorker({
        index,
        task: input.task,
        angle: state.angle,
        label: state.label,
        cwd: input.cwd,
        promptDir,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        timeoutMs,
        maxOutputBytes,
        screamBin: input.screamBin,
        onStarted: () => {
          state.status = 'running';
          emitProgress('planning');
        },
      }).then((result) => {
        state.status = result.ok ? 'completed' : 'failed';
        emitProgress('planning');
        return result;
      }),
    );

    const workerResults = await Promise.all(workerPromises);
    const successfulOutputs = workerResults
      .filter((r) => r.ok)
      .map((r) => truncateUtf8(r.output, maxOutputBytes));

    if (successfulOutputs.length === 0) {
      emitProgress('failed');
      return { ok: false, plan: '', workerResults };
    }

    emitProgress('synthesis');
    const plan = await runSynthesisWorker(
      {
        task: input.task,
        workerOutputs: successfulOutputs,
        cwd: input.cwd,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        timeoutMs,
        maxOutputBytes: input.synthesisMaxOutputBytes,
        screamBin: input.screamBin,
      },
      promptDir,
    );

    const ok = plan.length > 0 && !plan.startsWith('(synthesis failed');
    emitProgress(ok ? 'completed' : 'failed');
    return { ok, plan, workerResults };
  } finally {
    await cleanupPromptDir(promptDir);
  }
}
