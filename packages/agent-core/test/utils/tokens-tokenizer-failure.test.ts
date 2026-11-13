import { afterEach, describe, expect, it, vi } from 'vitest';

// The encoder factory fails the way a broken/partial js-tiktoken install would:
// every construction throws. Token estimation must degrade to the heuristic
// and never propagate the failure into a turn.
vi.mock('js-tiktoken/lite', () => ({
  Tiktoken: class {
    constructor() {
      throw new Error('rank lookup failed');
    }
  },
}));

/** Fresh module instance per test: the encoder cache and the warn-once flag are
 *  module state, so a shared instance would carry one test's failure into the
 *  next. */
async function loadTokens(): Promise<typeof import('#/utils/tokens')> {
  vi.resetModules();
  return import('#/utils/tokens');
}

describe('tokenizer failure fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the heuristic and warns only once', async () => {
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const { estimateTokens } = await loadTokens();

    expect(estimateTokens('x'.repeat(400), 'cl100k')).toBe(100);
    // Sticky failure: the encoder is not rebuilt (and not re-warned) per call.
    expect(estimateTokens('x'.repeat(400), 'cl100k')).toBe(100);
    // A second kind reuses the same warn-once flag.
    expect(estimateTokens('x'.repeat(400), 'o200k')).toBe(100);

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(String(emitWarning.mock.calls[0]?.[0])).toContain('tokenizer "cl100k"');
  });

  it('keeps the message and tool helpers on the heuristic instead of throwing', async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const { estimateTokensForMessages, estimateTokensForTools } = await loadTokens();

    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'x'.repeat(400) }],
      toolCalls: [],
    };
    expect(estimateTokensForMessages([message], 'cl100k')).toBe(101);
    expect(
      estimateTokensForTools(
        [{ name: 'read_file', description: 'Read a file.', parameters: {} }],
        'cl100k',
      ),
    ).toBe(7);
  });
});
