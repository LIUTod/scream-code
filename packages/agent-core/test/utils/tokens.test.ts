import type { Message, Tool } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '#/utils/tokens';

function textMessage(role: Message['role'], texts: readonly string[]): Message {
  return {
    role,
    content: texts.map((text) => ({ type: 'text', text })),
    toolCalls: [],
  };
}

const TOOL_FIXTURE: Tool = {
  name: 'read_file',
  description: 'Read a file from disk and return its contents.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};


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

/**
 * The heuristic stays the default so every existing caller keeps its exact
 * legacy numbers. These literals pin that contract: a change to the heuristic
 * (or an accidental switch of the default) fails here instead of silently
 * shifting every compaction watermark.
 */
describe('heuristic default (tokenizer omitted)', () => {
  it('returns the unchanged character-based counts', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(100);
    expect(estimateTokens('Mixed 中英文 sample: the quick brown fox 跳过了那只懒狗。')).toBe(20);
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBe(11);
    expect(estimateTokens('你好，世界！')).toBe(6);
  });

  it('keeps the message and tool join semantics unchanged', () => {
    expect(estimateTokensForMessages([textMessage('user', ['x'.repeat(400)])])).toBe(101);
    expect(estimateTokensForTools([TOOL_FIXTURE])).toBe(35);
    expect(
      estimateTokensForMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        toolCalls: [
          { type: 'function', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        ],
      }),
    ).toBe(13);
  });
});

describe('encoder tokenizer (cl100k / o200k)', () => {
  it('pins exact counts for fixed strings', () => {
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.', 'cl100k')).toBe(10);
    expect(estimateTokens('x'.repeat(400), 'cl100k')).toBe(50);
    // Mixed zh/en prose: the heuristic undercounts here (20), the encodings
    // disagree with each other — both are why the count is "near-exact".
    expect(estimateTokens('Mixed 中英文 sample: the quick brown fox 跳过了那只懒狗。', 'cl100k')).toBe(25);
    expect(estimateTokens('Mixed 中英文 sample: the quick brown fox 跳过了那只懒狗。', 'o200k')).toBe(19);
  });

  it('differs from the heuristic on mixed zh/en input and stays in a sane range', () => {
    const sample = 'Mixed 中英文 sample: the quick brown fox 跳过了那只懒狗。';
    const heuristic = estimateTokens(sample);
    const exact = estimateTokens(sample, 'cl100k');
    expect(exact).not.toBe(heuristic);
    expect(exact).toBeGreaterThanOrEqual(Math.floor(heuristic * 0.5));
    expect(exact).toBeLessThanOrEqual(heuristic * 2);
  });

  it('counts text parts exactly', () => {
    expect(estimateTokensForContentPart({ type: 'text', text: 'x'.repeat(400) }, 'cl100k')).toBe(50);
    expect(estimateTokensForContentPart({ type: 'think', think: 'x'.repeat(400) }, 'cl100k')).toBe(50);
  });

  it('keeps media estimates structural and tokenizer-independent', () => {
    expect(
      estimateTokensForContentPart(
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(64) } },
        'cl100k',
      ),
    ).toBe(1_600);
    expect(
      estimateTokensForContentPart({ type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } }, 'o200k'),
    ).toBe(2_000);
  });

  it('keeps the per-message structural overhead identical (role stays heuristic)', () => {
    // 'assistant' costs 3 on the heuristic (9 ASCII chars / 4, rounded up) but
    // 1 encoded; the role is fixed per-message overhead, so both modes agree.
    const empty = textMessage('assistant', ['']);
    expect(estimateTokensForMessage(empty)).toBe(3);
    expect(estimateTokensForMessage(empty, 'cl100k')).toBe(3);
  });

  it('counts message text and tool-call payloads exactly', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      toolCalls: [{ type: 'function', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
    };
    // role 3 (heuristic overhead) + 'ok' 1 + 'read_file' 2 + JSON-wrapped
    // arguments 8; the heuristic gives 3 + 1 + 3 + 6.
    expect(estimateTokensForMessage(message, 'cl100k')).toBe(14);
    expect(estimateTokensForMessage(message)).toBe(13);
    expect(estimateTokensForMessages([message], 'cl100k')).toBe(14);
  });

  it('counts tool declarations exactly with the same join as the heuristic', () => {
    // name 2 + description 10 + parameters JSON 18
    expect(estimateTokensForTools([TOOL_FIXTURE], 'cl100k')).toBe(30);
    expect(estimateTokensForTools([TOOL_FIXTURE])).toBe(35);
  });

  it('does not share the per-message cache across tokenizer kinds', () => {
    // Same object estimated twice in both modes: a shared cache would return
    // the first computed value for the second mode.
    const message = textMessage('user', ['x'.repeat(400)]);
    expect(estimateTokensForMessage(message, 'cl100k')).toBe(51);
    expect(estimateTokensForMessage(message)).toBe(101);
    expect(estimateTokensForMessage(message, 'o200k')).toBe(51);
  });
});
