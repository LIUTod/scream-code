import { describe, expect, it } from 'vitest';

import { estimateTokensForContentPart } from '#/utils/tokens';

/** Media parts must not count as 0: a zero estimate systematically
 *  under-reports the context watermark on media-heavy sessions and delays
 *  compaction. Text/think keep the char-based estimate. */
describe('estimateTokensForContentPart', () => {
  it('estimates text via the character heuristic', () => {
    const text = 'x'.repeat(400);
    expect(estimateTokensForContentPart({ type: 'text', text })).toBe(100);
  });

  it('gives image parts a positive conservative base estimate', () => {
    const tokens = estimateTokensForContentPart({
      type: 'image_url',
      imageUrl: { url: 'https://example.com/a.png' },
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it('estimates small data-URI images at the base value', () => {
    const tokens = estimateTokensForContentPart({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(64) },
    });
    expect(tokens).toBe(1_600);
  });

  it('grows the estimate for large data-URI payloads and caps it', () => {
    // 512_000-byte threshold + 3/4 base64 → bytes; 1MB payload ≈ 786_432 bytes
    // → base + floor((bytes - threshold)/1000) ≈ 1600 + 274 = 1874.
    const big = estimateTokensForContentPart({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(1_048_576) },
    });
    expect(big).toBeGreaterThan(1_600);
    // 100MB payload must clamp to the cap.
    const huge = estimateTokensForContentPart({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(100_000_000) },
    });
    expect(huge).toBe(8_000);
  });

  it('gives audio and video parts fixed conservative estimates', () => {
    expect(
      estimateTokensForContentPart({ type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } }),
    ).toBe(2_000);
    expect(
      estimateTokensForContentPart({ type: 'video_url', videoUrl: { url: 'https://example.com/v.mp4' } }),
    ).toBe(5_000);
  });
});
