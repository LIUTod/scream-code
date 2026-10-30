/**
 * WeChat voice outbound: the gateway expects AMR-NB (`voice_item.encode_type
 * = 0`), so any other audio is transcoded with ffmpeg first.
 *
 * Cross-platform notes (product runs on macOS / Linux / Windows):
 * - ffmpeg is looked up on PATH (`ffmpeg` / `ffmpeg.exe`); its absence is a
 *   first-class, typed condition so the caller can fall back to a file message
 *   instead of failing the turn.
 * - The transcode pipes through stdin/stdout (no temp files, no `/bin/sh`
 *   dependency, no quoting issues), which is also how the reference does it.
 * - ffmpeg must be built with an AMR-NB **encoder** (`libopencore_amrnb`); many
 *   package-manager builds ship only the decoder. That surfaces as a non-zero
 *   exit and is reported with the stderr tail.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** ffmpeg is not installed (or not on PATH). Callers fall back to a file send. */
export class FfmpegUnavailableError extends Error {
  constructor() {
    super('未找到 ffmpeg，无法转换语音（可安装 ffmpeg 后重试，或改为发送文件）');
    this.name = 'FfmpegUnavailableError';
  }
}

/** ffmpeg ran but refused the job (usually: no AMR encoder in this build). */
export class AudioConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioConversionError';
  }
}

// `#!AMR\n` = AMR-NB (what the gateway wants); `#!AMR-WB` is wideband and must
// be transcoded, so the match includes the NB trailing newline only.
const AMR_NB_MAGIC = Buffer.from('#!AMR\n', 'latin1');
const CONVERT_TIMEOUT_MS = 30_000;
/** Guard against a runaway encoder filling memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL = 400;

/**
 * ffmpeg writes progress to stderr, so the last bytes are often a progress
 * line (`/ 6. 3.100`). Prefer the lines that actually explain the failure and
 * fall back to the tail.
 */
function describeStderr(stderr: Buffer): string {
  const lines = stderr
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const relevant = lines.filter((line) => /error|unknown|invalid|not found|failed|no such/i.test(line));
  const chosen = (relevant.length > 0 ? relevant : lines).slice(-3).join(' | ');
  const hint = /unknown encoder/i.test(stderr.toString('utf8'))
    ? '（该 ffmpeg 不含 AMR-NB 编码器，请安装带 libopencore-amr 的构建）'
    : '';
  return `${chosen.slice(-STDERR_TAIL)}${hint}`;
}

/** True only for AMR-NB; AMR-WB (`#!AMR-WB\n`) needs transcoding. */
export function isAmr(audio: Buffer): boolean {
  return (
    audio.length >= AMR_NB_MAGIC.length &&
    audio.subarray(0, AMR_NB_MAGIC.length).equals(AMR_NB_MAGIC)
  );
}

export interface ConvertToAmrOptions {
  /** Override the ffmpeg binary (tests, non-standard installs). */
  ffmpegPath?: string;
  /** Override the runner; production uses ffmpeg with stdin/stdout pipes. */
  run?: (ffmpeg: string, args: string[], input: Buffer) => Promise<Buffer>;
  /** Override the PATH lookup (tests). */
  find?: () => Promise<string | null>;
}

/** Positive results are cached for the process; a miss is retried after a
 *  short TTL so installing ffmpeg mid-session is picked up. */
let cachedFfmpeg: string | null | undefined;
let cachedMissAt = 0;
const MISS_TTL_MS = 60_000;

export async function findFfmpeg(): Promise<string | null> {
  if (cachedFfmpeg !== undefined && cachedFfmpeg !== null) return cachedFfmpeg;
  if (cachedFfmpeg === null && Date.now() - cachedMissAt < MISS_TTL_MS) return null;
  for (const candidate of process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']) {
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5_000 });
      cachedFfmpeg = candidate;
      return candidate;
    } catch {
      // Not on PATH under this name; try the next one.
    }
  }
  cachedFfmpeg = null;
  cachedMissAt = Date.now();
  return null;
}

/** Test hook: forget the cached lookup. */
export function resetFfmpegCache(): void {
  cachedFfmpeg = undefined;
  cachedMissAt = 0;
}

async function runFfmpeg(ffmpeg: string, args: string[], input: Buffer): Promise<Buffer> {
  // `spawn`, not `execFile`: execFile decodes stdout according to `encoding`
  // (utf8 by default) and would mangle the AMR bytes; we need raw Buffers.
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let settled = false;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, CONVERT_TIMEOUT_MS);
  timer.unref?.();

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      child.kill('SIGKILL');
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on('error', () => {
    // ffmpeg can exit before consuming stdin; the exit code carries the reason.
  });

  // Feed the encoder up front: ffmpeg only finishes once stdin reaches EOF.
  try {
    child.stdin.end(input);
  } catch {
    // The child may already have exited; the close handler reports the reason.
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      child.once('error', (error: NodeJS.ErrnoException) => {
        finish(
          error.code === 'ENOENT'
            ? new FfmpegUnavailableError()
            : new AudioConversionError(`ffmpeg 启动失败：${error.message}`),
        );
      });
      child.once('close', (code, signal) => {
        if (code === 0 && !timedOut) {
          finish();
          return;
        }
        const tail = describeStderr(Buffer.concat(stderr));
        const reason = timedOut
          ? `超时（${CONVERT_TIMEOUT_MS / 1000}s）`
          : code === null
            ? `被信号 ${signal ?? 'unknown'} 终止`
            : `退出码 ${String(code)}`;
        finish(
          new AudioConversionError(
            `ffmpeg 转换 AMR 失败（${reason}）${tail.length > 0 ? `：${tail}` : ''}`,
          ),
        );
      });
    });
  } catch (error) {
    child.stdin.destroy();
    throw error;
  }

  const output = Buffer.concat(stdout);
  if (output.length === 0) {
    throw new AudioConversionError('ffmpeg 没有输出音频数据');
  }
  return output;
}

/**
 * Transcodes arbitrary audio to AMR-NB (8 kHz, mono, 12.2 kbps), the shape the
 * ilink gateway expects for a voice bubble. AMR input is returned unchanged.
 */
export async function convertToAmr(
  audio: Buffer,
  options: ConvertToAmrOptions = {},
): Promise<Buffer> {
  if (isAmr(audio)) return audio;
  const ffmpeg = options.ffmpegPath ?? (await (options.find ?? findFfmpeg)());
  if (ffmpeg === null) throw new FfmpegUnavailableError();
  const args = [
    '-i',
    'pipe:0',
    '-c:a',
    'amr_nb',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-b:a',
    '12.2k',
    '-f',
    'amr',
    '-y',
    'pipe:1',
  ];
  const run = options.run ?? runFfmpeg;
  return run(ffmpeg, args, audio);
}
