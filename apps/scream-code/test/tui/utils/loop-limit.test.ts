import { describe, expect, it } from 'vitest';

import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  parseLoopLimitArgs,
} from '#/tui/utils/loop-limit';

describe('parseLoopLimitArgs', () => {
  it('returns empty args for empty input', () => {
    expect(parseLoopLimitArgs('')).toEqual({});
  });

  it('treats prose as an unbounded prompt', () => {
    expect(parseLoopLimitArgs('keep going')).toEqual({ prompt: 'keep going' });
  });

  it('parses a bare iteration count', () => {
    expect(parseLoopLimitArgs('5')).toEqual({
      limit: { kind: 'iterations', iterations: 5 },
    });
  });

  it('parses an iteration count and trailing prompt', () => {
    expect(parseLoopLimitArgs('10 fix the tests')).toEqual({
      limit: { kind: 'iterations', iterations: 10 },
      prompt: 'fix the tests',
    });
  });

  it('parses compact duration', () => {
    expect(parseLoopLimitArgs('5m')).toEqual({
      limit: { kind: 'duration', durationMs: 5 * 60_000 },
    });
    expect(parseLoopLimitArgs('90s')).toEqual({
      limit: { kind: 'duration', durationMs: 90_000 },
    });
    expect(parseLoopLimitArgs('1h30m')).toEqual({
      limit: { kind: 'duration', durationMs: 90 * 60_000 },
    });
  });

  it('parses duration with spaced unit and prompt', () => {
    expect(parseLoopLimitArgs('10 minutes refactor code')).toEqual({
      limit: { kind: 'duration', durationMs: 10 * 60_000 },
      prompt: 'refactor code',
    });
  });

  it('rejects zero and negative limits', () => {
    expect(parseLoopLimitArgs('0')).toBe('循环次数必须是正整数。');
    expect(parseLoopLimitArgs('-1')).toBe('循环次数必须是正整数。');
    expect(parseLoopLimitArgs('0m')).toBe('循环时长必须为正数。');
  });

  it('rejects unknown units', () => {
    expect(parseLoopLimitArgs('10x')).toBe(
      '循环时长单位必须是秒、分钟或小时。',
    );
  });
});

describe('createLoopLimitRuntime', () => {
  it('returns undefined for undefined config', () => {
    expect(createLoopLimitRuntime(undefined)).toBeUndefined();
  });

  it('creates iteration runtime', () => {
    expect(createLoopLimitRuntime({ kind: 'iterations', iterations: 3 })).toEqual({
      kind: 'iterations',
      initial: 3,
      remaining: 3,
    });
  });

  it('creates duration runtime', () => {
    const now = 1_000_000;
    expect(createLoopLimitRuntime({ kind: 'duration', durationMs: 60_000 }, now)).toEqual({
      kind: 'duration',
      durationMs: 60_000,
      deadlineMs: now + 60_000,
    });
  });
});

describe('consumeLoopLimitIteration', () => {
  it('iterates down remaining count', () => {
    const runtime = createLoopLimitRuntime({ kind: 'iterations', iterations: 3 });
    expect(runtime).toBeDefined();
    const limit = runtime!;
    expect(limit.kind).toBe('iterations');
    if (limit.kind !== 'iterations') throw new Error('expected iteration limit');
    expect(consumeLoopLimitIteration(limit)).toBe(true);
    expect(limit.remaining).toBe(2);
    expect(consumeLoopLimitIteration(limit)).toBe(true);
    expect(limit.remaining).toBe(1);
    expect(consumeLoopLimitIteration(limit)).toBe(true);
    expect(limit.remaining).toBe(0);
    expect(consumeLoopLimitIteration(limit)).toBe(false);
  });

  it('respects duration deadline', () => {
    const now = 1_000_000;
    const limit = createLoopLimitRuntime(
      { kind: 'duration', durationMs: 60_000 },
      now,
    );
    expect(limit).toBeDefined();
    expect(consumeLoopLimitIteration(limit, now + 1)).toBe(true);
    expect(consumeLoopLimitIteration(limit, now + 60_000)).toBe(false);
  });

  it('always allows undefined limit', () => {
    expect(consumeLoopLimitIteration(undefined)).toBe(true);
  });
});

describe('describeLoopLimit', () => {
  it('describes iteration config', () => {
    expect(describeLoopLimit({ kind: 'iterations', iterations: 1 })).toBe('1 次');
    expect(describeLoopLimit({ kind: 'iterations', iterations: 5 })).toBe('5 次');
  });

  it('describes duration config', () => {
    expect(describeLoopLimit({ kind: 'duration', durationMs: 60_000 })).toBe('1 分钟');
    expect(describeLoopLimit({ kind: 'duration', durationMs: 2 * 60_000 })).toBe('2 分钟');
  });
});

describe('describeLoopLimitRuntime', () => {
  it('describes iteration runtime', () => {
    expect(
      describeLoopLimitRuntime({ kind: 'iterations', initial: 5, remaining: 3 }),
    ).toBe('剩余 3/5 次');
  });

  it('describes duration runtime', () => {
    const now = 1_000_000;
    expect(
      describeLoopLimitRuntime(
        { kind: 'duration', durationMs: 120_000, deadlineMs: now + 60_000 },
        now,
      ),
    ).toBe('剩余 1 分钟');
  });

  it('describes expired duration runtime', () => {
    const now = 1_000_000;
    expect(
      describeLoopLimitRuntime(
        { kind: 'duration', durationMs: 120_000, deadlineMs: now - 1 },
        now,
      ),
    ).toBe('已过期');
  });
});
