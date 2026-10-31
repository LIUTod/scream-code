/**
 * Startup capability probe for outbound voice.
 *
 * Voice sending is the one path that depends on the host's ffmpeg being built
 * with an AMR-NB *encoder* — plenty of package-manager builds ship the decoder
 * only. Discovering that at send time turns every voice reply into a fallback
 * file plus an apology, so the daemon probes once at startup and reports the
 * answer in `/status`.
 *
 * The probe never throws: a failure to answer is `unknown`, which is treated as
 * "try anyway" rather than "unavailable".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

export type VoiceSupport =
  /** ffmpeg is present and lists an AMR-NB encoder. */
  | 'ready'
  /** No ffmpeg on PATH; voice always degrades to a file message. */
  | 'no-ffmpeg'
  /** ffmpeg exists but cannot encode AMR-NB (decoder-only build). */
  | 'no-encoder'
  /** The probe itself failed (timeout, permissions…). Try sending anyway. */
  | 'unknown';

/** Parses `ffmpeg -encoders` output for an AMR-NB encoder. */
export function parseAmrEncoderListing(stdout: string): boolean {
  return stdout
    .split(/\r?\n/)
    .some((line) => /\bamr_nb\b|\blibopencore_amrnb\b/i.test(line) && /^\s*A/.test(line));
}

/** One-shot probe; callers cache the result (ffmpeg does not appear mid-run). */
export async function probeVoiceSupport(): Promise<VoiceSupport> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-encoders'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return parseAmrEncoderListing(stdout) ? 'ready' : 'no-encoder';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'ENOENT' ? 'no-ffmpeg' : 'unknown';
  }
}

/** One-line description for `/status`; `null` when no probe has run yet. */
export function describeVoiceSupport(support: VoiceSupport | null): string | null {
  switch (support) {
    case 'ready':
      return '语音：可用（AMR-NB）';
    case 'no-ffmpeg':
      return '语音：不可用（未找到 ffmpeg，将改发文件）';
    case 'no-encoder':
      return '语音：不可用（ffmpeg 缺少 AMR-NB 编码器，将改发文件）';
    case 'unknown':
      return '语音：未确认（ffmpeg 探测失败，发送时再判断）';
    case null:
      return null;
  }
}
