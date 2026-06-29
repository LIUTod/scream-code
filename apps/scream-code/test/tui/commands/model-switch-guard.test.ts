import { describe, expect, it } from 'vitest';

import { contextOverflowForModel } from '#/tui/commands/config';

interface GuardState {
  contextTokens: number;
  availableModels: Record<string, { maxContextSize: number }>;
}

function makeState(overrides: Partial<GuardState> = {}): GuardState {
  return {
    contextTokens: 0,
    availableModels: {
      small: { maxContextSize: 8_000 },
      large: { maxContextSize: 200_000 },
    },
    ...overrides,
  };
}

describe('contextOverflowForModel (Storm Breaker model-switch guard)', () => {
  it('returns null when current tokens fit within the target model window', () => {
    const state = makeState({ contextTokens: 5_000 });
    expect(contextOverflowForModel(state, 'small')).toBeNull();
    expect(contextOverflowForModel(state, 'large')).toBeNull();
  });

  it('returns overflow when current tokens exceed the target model window', () => {
    const state = makeState({ contextTokens: 10_000 });
    const overflow = contextOverflowForModel(state, 'small');
    expect(overflow).toEqual({ currentTokens: 10_000, maxContextTokens: 8_000 });
  });

  it('returns null when contextTokens is exactly at the limit (boundary)', () => {
    const state = makeState({ contextTokens: 8_000 });
    expect(contextOverflowForModel(state, 'small')).toBeNull();
  });

  it('returns null when current tokens is zero (no session content yet)', () => {
    const state = makeState({ contextTokens: 0 });
    expect(contextOverflowForModel(state, 'small')).toBeNull();
  });

  it('returns null when the target alias is not in availableModels', () => {
    const state = makeState({ contextTokens: 100_000 });
    expect(contextOverflowForModel(state, 'unknown-alias')).toBeNull();
  });

  it('allows switching to a larger-window model when current exceeds a smaller one', () => {
    // Session at 50k tokens — too big for `small` (8k) but fits `large` (200k).
    const state = makeState({ contextTokens: 50_000 });
    expect(contextOverflowForModel(state, 'small')).not.toBeNull();
    expect(contextOverflowForModel(state, 'large')).toBeNull();
  });
});
