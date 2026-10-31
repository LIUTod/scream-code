import { describe, expect, it } from 'vitest';

import { describeVoiceSupport, parseAmrEncoderListing } from '#/line/voice-support';

const FFMPEG_ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopencore_amrnb    OpenCORE AMR-NB (Adaptive Multi-Rate Narrow-Band)
 A....D libopencore_amrwb    OpenCORE AMR-WB (Adaptive Multi-Rate Wide-Band)
 A....D libopus              libopus Opus`;

// A decoder-only build simply does not list the encoder.
const DECODER_ONLY = `Encoders:
 ------
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus`;

describe('parseAmrEncoderListing', () => {
  it('finds an AMR-NB encoder', () => {
    expect(parseAmrEncoderListing(FFMPEG_ENCODERS)).toBe(true);
  });

  it('rejects a build without the encoder', () => {
    expect(parseAmrEncoderListing(DECODER_ONLY)).toBe(false);
    expect(parseAmrEncoderListing('Encoders:\n A....D aac  AAC')).toBe(false);
  });
});

describe('describeVoiceSupport', () => {
  it('maps every probe answer to a one-line status', () => {
    expect(describeVoiceSupport('ready')).toContain('可用');
    expect(describeVoiceSupport('no-ffmpeg')).toContain('未找到 ffmpeg');
    expect(describeVoiceSupport('no-encoder')).toContain('AMR-NB 编码器');
    expect(describeVoiceSupport('unknown')).toContain('未确认');
    expect(describeVoiceSupport(null)).toBeNull();
  });
});
