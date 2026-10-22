import { describe, expect, it } from 'vitest';

import {
  STREAMING_PHASES,
  canTransitionTo,
  type StreamingPhase,
} from '#/tui/streaming-phase';

describe('streaming-phase', () => {
  describe('STREAMING_PHASES', () => {
    it('enumerates the six canonical phases', () => {
      expect(STREAMING_PHASES).toEqual([
        'idle',
        'waiting',
        'thinking',
        'composing',
        'tool-args',
        'tool',
      ]);
    });
  });

  describe('canTransitionTo', () => {
    it('returns false for self-loops (idempotency guard)', () => {
      for (const phase of STREAMING_PHASES) {
        expect(canTransitionTo(phase, phase)).toBe(false);
      }
    });

    it('returns true for any non-self transition', () => {
      const cases: Array<[StreamingPhase, StreamingPhase]> = [
        ['idle', 'waiting'],
        ['idle', 'thinking'],
        ['idle', 'composing'],
        ['idle', 'tool'],
        ['waiting', 'thinking'],
        ['waiting', 'composing'],
        ['waiting', 'tool'],
        ['waiting', 'idle'],
        ['thinking', 'composing'],
        ['thinking', 'tool'],
        ['thinking', 'waiting'],
        ['thinking', 'idle'],
        ['composing', 'thinking'],
        ['composing', 'tool'],
        ['composing', 'waiting'],
        ['composing', 'idle'],
        ['composing', 'tool-args'],
        ['tool-args', 'tool'],
        ['tool-args', 'composing'],
        ['tool-args', 'waiting'],
        ['tool', 'composing'],
        ['tool', 'thinking'],
        ['tool', 'waiting'],
        ['tool', 'idle'],
      ];
      for (const [from, to] of cases) {
        expect(canTransitionTo(from, to)).toBe(true);
      }
    });

    it('covers every directed pair across the phase space', () => {
      // Sanity: 6 phases × 6 phases = 36 (from,to) pairs.
      // 6 self-loops return false; the remaining 30 return true.
      let trueCount = 0;
      let falseCount = 0;
      for (const from of STREAMING_PHASES) {
        for (const to of STREAMING_PHASES) {
          if (canTransitionTo(from, to)) trueCount += 1;
          else falseCount += 1;
        }
      }
      expect(trueCount).toBe(30);
      expect(falseCount).toBe(6);
    });
  });
});
