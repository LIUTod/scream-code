import { describe, expect, it, vi } from 'vitest';

import {
  AudioConversionError,
  FfmpegUnavailableError,
  convertToAmr,
  findFfmpeg,
  isAmr,
} from '#/line/weixin/voice';

const AMR_HEADER = Buffer.from('#!AMR\n', 'latin1');

describe('isAmr', () => {
  it('treats AMR-WB as needing transcoding', () => {
    // The gateway wants narrowband; wideband would decode but be malformed.
    expect(isAmr(Buffer.from('#!AMR-WB\n...', 'latin1'))).toBe(false);
  });

  it('recognises the AMR magic header', () => {
    expect(isAmr(Buffer.concat([AMR_HEADER, Buffer.alloc(10)]))).toBe(true);
    expect(isAmr(Buffer.from('RIFF....WAVE'))).toBe(false);
    expect(isAmr(Buffer.alloc(0))).toBe(false);
  });
});

describe('convertToAmr', () => {
  it('returns AMR input untouched without touching ffmpeg', async () => {
    const run = vi.fn();
    const find = vi.fn();
    const amr = Buffer.concat([AMR_HEADER, Buffer.from([0x01, 0x02])]);
    await expect(convertToAmr(amr, { run, find })).resolves.toBe(amr);
    expect(run).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('spawns ffmpeg with the AMR-NB parameters the gateway expects', async () => {
    const run = vi.fn(
      async (_ffmpeg: string, _args: string[], _input: Buffer) =>
        Buffer.concat([AMR_HEADER, Buffer.from([9])]),
    );
    const result = await convertToAmr(Buffer.from('wav-bytes'), {
      ffmpegPath: 'ffmpeg',
      run,
    });

    expect(result.subarray(0, 6).toString('latin1')).toBe('#!AMR\n');
    const args = run.mock.calls[0]?.[1] ?? [];
    expect(args).toEqual([
      '-i', 'pipe:0',
      '-c:a', 'amr_nb',
      '-ar', '8000',
      '-ac', '1',
      '-b:a', '12.2k',
      '-f', 'amr',
      '-y', 'pipe:1',
    ]);
  });

  it('raises a typed error when ffmpeg is not installed', async () => {
    await expect(
      convertToAmr(Buffer.from('wav'), { find: async () => null }),
    ).rejects.toBeInstanceOf(FfmpegUnavailableError);
  });

  it('raises a typed error when ffmpeg rejects the job (no AMR encoder)', async () => {
    await expect(
      convertToAmr(Buffer.from('wav'), {
        ffmpegPath: 'ffmpeg',
        run: async () => {
          throw new AudioConversionError('ffmpeg 转换 AMR 失败（退出码 1）：Unknown encoder');
        },
      }),
    ).rejects.toBeInstanceOf(AudioConversionError);
  });

  it('findFfmpeg returns null instead of throwing when nothing is on PATH', async () => {
    // The host may or may not have ffmpeg; the contract is "no exception".
    const found = await findFfmpeg();
    expect(found === null || typeof found === 'string').toBe(true);
  });
});
