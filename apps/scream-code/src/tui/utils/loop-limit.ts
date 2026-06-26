export type LoopLimitConfig =
  | {
      kind: 'iterations';
      iterations: number;
    }
  | {
      kind: 'duration';
      durationMs: number;
    };

export type LoopLimitRuntime =
  | {
      kind: 'iterations';
      initial: number;
      remaining: number;
    }
  | {
      kind: 'duration';
      durationMs: number;
      deadlineMs: number;
    };

export interface ParsedLoopArgs {
  /** Iteration/duration budget, when the user supplied a leading limit token. */
  limit?: LoopLimitConfig;
  /** Inline loop prompt: text after the limit, or the whole argument when no limit was given. */
  prompt?: string;
}

const TIME_UNITS_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

const LOOP_USAGE = '用法：/loop [次数|时长] [提示词]。示例：/loop 10、/loop 5m、/loop 10 继续优化';

/**
 * 将 `/loop` 参数解析为可选的前置限制和可选的内联提示词。
 * 看起来像限制（以数字或正负号开头）但解析失败的 token 视为硬错误；
 * 其他内容都视为提示词文本，因此 `/loop` 后面跟普通 prose 会开启无限制循环。
 * 失败时返回错误信息字符串。
 */
export function parseLoopLimitArgs(args: string): ParsedLoopArgs | string {
  const trimmed = args.trim();
  if (!trimmed) return {};

  const firstSpace = trimmed.search(/\s/);
  const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const token = firstToken.toLowerCase();

  // 不是限制尝试（如 "keep going"）→ 无限制循环，prompt = 完整参数。
  if (!/^[+-]?\d/.test(token)) {
    return { prompt: trimmed };
  }

  // 纯整数（可选正负号）：迭代次数，除非下一个 token 是时间单位（"10 minutes"）。
  if (/^[+-]?\d+$/.test(token)) {
    if (token.startsWith('-')) {
      return '循环次数必须是正整数。';
    }
    if (rest) {
      const restTokens = rest.split(/\s+/);
      const firstRestToken = restTokens[0];
      if (firstRestToken !== undefined) {
        const unitMs = TIME_UNITS_MS[firstRestToken.toLowerCase()];
        if (unitMs !== undefined) {
          const limit = makeDuration(token, unitMs);
          if (typeof limit === 'string') return limit;
          return { limit, prompt: restTokens.slice(1).join(' ').trim() || undefined };
        }
      }
    }
    const limit = makeIterations(token);
    if (typeof limit === 'string') return limit;
    return { limit, prompt: rest || undefined };
  }

  // 紧凑 / 组合时长："10m"、"90s"、"1h30m"。
  const duration = parseCompoundDuration(token);
  if (duration !== undefined) {
    if (typeof duration === 'string') return duration;
    return { limit: duration, prompt: rest || undefined };
  }

  // 看起来像限制但无法解析（"-1"、"1.5h"、"10x10"）。
  return LOOP_USAGE;
}

function makeIterations(amountText: string): LoopLimitConfig | string {
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return '循环次数必须是正整数。';
  }
  return { kind: 'iterations', iterations: amount };
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return '循环时长必须为正数。';
  }
  return { kind: 'duration', durationMs: amount * unitMs };
}

function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
  if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
  const segments = token.match(/\d+[a-z]+/g);
  if (!segments) return undefined;
  let totalMs = 0;
  for (const segment of segments) {
    const match = /^(\d+)([a-z]+)$/.exec(segment);
    if (!match) return LOOP_USAGE;
    const unitName = match[2];
    if (unitName === undefined) return LOOP_USAGE;
    const unitMs = TIME_UNITS_MS[unitName];
    if (unitMs === undefined) {
      return '循环时长单位必须是秒、分钟或小时。';
    }
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return '循环时长必须为正数。';
    }
    totalMs += amount * unitMs;
  }
  if (totalMs <= 0) return '循环时长必须为正数。';
  return { kind: 'duration', durationMs: totalMs };
}

export function createLoopLimitRuntime(
  config: LoopLimitConfig | undefined,
  nowMs = Date.now(),
): LoopLimitRuntime | undefined {
  if (!config) return undefined;
  if (config.kind === 'iterations') {
    return { kind: 'iterations', initial: config.iterations, remaining: config.iterations };
  }
  return { kind: 'duration', durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

export function consumeLoopLimitIteration(
  limit: LoopLimitRuntime | undefined,
  nowMs = Date.now(),
): boolean {
  if (!limit) return true;
  if (limit.kind === 'duration') {
    return nowMs < limit.deadlineMs;
  }
  if (limit.remaining <= 0) return false;
  limit.remaining -= 1;
  return true;
}

export function isLoopLimitExpired(
  limit: LoopLimitRuntime | undefined,
  nowMs = Date.now(),
): boolean {
  if (!limit) return false;
  if (limit.kind === 'duration') return nowMs >= limit.deadlineMs;
  return limit.remaining <= 0;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
  if (config.kind === 'iterations') {
    return `${config.iterations} 次`;
  }
  return formatDuration(config.durationMs);
}

export function describeLoopLimitRuntime(
  limit: LoopLimitRuntime,
  nowMs = Date.now(),
): string {
  if (limit.kind === 'iterations') {
    return `剩余 ${limit.remaining}/${limit.initial} 次`;
  }
  const remainingMs = limit.deadlineMs - nowMs;
  if (remainingMs <= 0) return '已过期';
  return `剩余 ${formatDuration(remainingMs)}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs % 3_600_000 === 0) {
    const hours = durationMs / 3_600_000;
    return `${hours} 小时`;
  }
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} 分钟`;
  }
  const seconds = durationMs / 1_000;
  return `${seconds} 秒`;
}
