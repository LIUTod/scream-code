import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addDays,
  emptyLedger,
  LEDGER_VERSION,
  loadLedger,
  localDateKey,
  MODEL_DETAIL_DAYS,
  MODEL_DETAIL_LIMIT,
  normalizeModelId,
  OTHER_MODELS,
  pruneLedger,
  saveLedger,
  scanUsage,
  summarizeUsage,
  UsageTracker,
  type DayUsage,
} from '#/tui/utils/usage-ledger';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const at = (key: string, hour = 12): number => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!, hour).getTime();
};

function record(key: string, model: string, usage: Partial<Record<'inputOther' | 'inputCacheRead' | 'inputCacheCreation' | 'output', number>>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'usage.record', model, time: at(key), usageScope: 'turn', usage, ...extra });
}

let sessionCount = 0;
function writeWire(lines: string[], mtimeKey?: string, agent = 'main'): string {
  const dir = join(home, 'sessions', 'wd_test', `session_${String(++sessionCount)}`, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'wire.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtimeKey !== undefined) utimesSync(file, new Date(at(mtimeKey)), new Date(at(mtimeKey)));
  return file;
}

describe('normalizeModelId', () => {
  it('names a model by its id alone, whatever alias it was reached through', () => {
    expect(normalizeModelId('custom-my-alias/alpha-v4.1-flash')).toBe('alpha-v4.1-flash');
    expect(normalizeModelId('vendor/alpha-v4.1-flash')).toBe('alpha-v4.1-flash');
    expect(normalizeModelId('custom-x/vendor/beta-5.3-flash')).toBe('beta-5.3-flash');
    expect(normalizeModelId('plain-model')).toBe('plain-model');
    expect(normalizeModelId('trailing/')).toBe('trailing/');
  });
});

describe('scanUsage', () => {
  it('counts input (cache included), output and requests by local day, with models merged by id', async () => {
    writeWire([
      record('2026-11-20', 'custom-a/alpha', { inputOther: 100, inputCacheRead: 900, inputCacheCreation: 50, output: 10 }),
      record('2026-11-20', 'vendor/alpha', { inputOther: 5, output: 5 }),
      record('2026-11-21', 'custom-b/beta', { inputCacheRead: 1000, output: 1 }),
    ]);
    const days = await scanUsage({ sessionsDir: join(home, 'sessions'), sinceMs: 0 });
    expect(days.get('2026-11-20')).toMatchObject({ tokens: 1070, input: 1055, cacheRead: 900, requests: 2, models: { alpha: 1070 } });
    expect(days.get('2026-11-21')).toMatchObject({ tokens: 1001, requests: 1, models: { beta: 1001 } });
  });

  it('does not count a record that re-records a subagent, or anything that is not a usage record', async () => {
    writeWire([
      record('2026-11-20', 'a/alpha', { inputOther: 10, output: 0 }),
      record('2026-11-20', 'a/alpha', { inputOther: 999, output: 0 }, { fold: { childId: 'c', cumulative: {} } }),
      JSON.stringify({ type: 'turn.prompt', time: at('2026-11-20'), input: 'usage.record' }),
      'not json at all "usage.record"',
      '',
    ]);
    const days = await scanUsage({ sessionsDir: join(home, 'sessions'), sinceMs: 0 });
    expect(days.get('2026-11-20')?.tokens).toBe(10);
    expect(days.get('2026-11-20')?.requests).toBe(1);
  });

  it('counts a subagent log of its own, and several sessions together', async () => {
    writeWire([record('2026-11-20', 'a/alpha', { output: 7 })]);
    writeWire([record('2026-11-20', 'a/alpha', { output: 3 })], undefined, 'agent-1');
    const days = await scanUsage({ sessionsDir: join(home, 'sessions'), sinceMs: 0 });
    expect(days.get('2026-11-20')?.tokens).toBe(10);
  });

  it('keeps to the days asked for and to files changed since', async () => {
    writeWire([record('2026-11-18', 'a/m', { output: 1 }), record('2026-11-20', 'a/m', { output: 2 }), record('2026-11-22', 'a/m', { output: 4 })], '2026-11-22');
    writeWire([record('2026-11-10', 'a/m', { output: 8 })], '2026-11-10');
    const days = await scanUsage({ sessionsDir: join(home, 'sessions'), sinceMs: at('2026-11-19', 0), from: '2026-11-19', to: '2026-11-21' });
    expect([...days.keys()]).toEqual(['2026-11-20']);
  });

  it('reports progress, newest file first, and tolerates a missing folder', async () => {
    writeWire([record('2026-11-01', 'a/m', { output: 1 })], '2026-11-01');
    writeWire([record('2026-11-25', 'a/m', { output: 2 })], '2026-11-25');
    const seen: Array<{ done: number; total: number; keys: string[] }> = [];
    await scanUsage({
      sessionsDir: join(home, 'sessions'),
      sinceMs: 0,
      onProgress: (days, done, total) => seen.push({ done, total, keys: [...days.keys()] }),
    });
    expect(seen.map((s) => [s.done, s.total])).toEqual([[1, 2], [2, 2]]);
    expect(seen[0]!.keys).toEqual(['2026-11-25']);
    expect(await scanUsage({ sessionsDir: join(home, 'nope'), sinceMs: 0 })).toEqual(new Map());
  });
});

describe('ledger file', () => {
  it('round-trips through the file and ignores a foreign or broken one', () => {
    const ledger = emptyLedger();
    ledger.computedThrough = '2026-11-26';
    ledger.days['2026-11-26'] = { tokens: 5, input: 3, cacheRead: 1, requests: 1, models: { alpha: 5 } };
    saveLedger(home, ledger);
    expect(loadLedger(home)).toEqual(ledger);

    writeFileSync(join(home, 'usage-ledger.json'), JSON.stringify({ version: LEDGER_VERSION + 1, days: {} }));
    expect(loadLedger(home)).toEqual(emptyLedger());
    writeFileSync(join(home, 'usage-ledger.json'), '{ broken');
    expect(loadLedger(home)).toEqual(emptyLedger());
    writeFileSync(join(home, 'usage-ledger.json'), JSON.stringify({ version: LEDGER_VERSION, computedThrough: 'x', days: { '2026-11-01': { tokens: 'many' }, bad: {} } }));
    expect(loadLedger(home)).toEqual(emptyLedger());
  });

  it('leaves no temporary file behind', () => {
    saveLedger(home, emptyLedger());
    expect(existsSync(join(home, `usage-ledger.json.${String(process.pid)}.tmp`))).toBe(false);
  });

  it('keeps per-model detail for recent days only, at most MODEL_DETAIL_LIMIT a day, the rest as "other"', () => {
    const ledger = emptyLedger();
    const today = '2026-11-27';
    const many: Record<string, number> = {};
    for (let i = 0; i < MODEL_DETAIL_LIMIT + 5; i++) many[`model-${String(i)}`] = 100 - i;
    const make = (): DayUsage => ({ tokens: 1, input: 1, cacheRead: 0, requests: 1, models: { ...many } });
    ledger.days[today] = make();
    ledger.days[addDays(today, -MODEL_DETAIL_DAYS - 1)] = make();
    pruneLedger(ledger, today);
    const recent = ledger.days[today]!.models!;
    expect(Object.keys(recent)).toHaveLength(MODEL_DETAIL_LIMIT);
    expect(recent['model-0']).toBe(100);
    expect(recent[OTHER_MODELS]).toBe(Object.values(many).slice(MODEL_DETAIL_LIMIT - 1).reduce((a, b) => a + b, 0));
    expect(ledger.days[addDays(today, -MODEL_DETAIL_DAYS - 1)]!.models).toBeUndefined();
    expect(ledger.days[addDays(today, -MODEL_DETAIL_DAYS - 1)]!.tokens).toBe(1);
  });
});

describe('UsageTracker', () => {
  const NOW = new Date(2026, 10, 27, 15).getTime();

  async function settled(tracker: UsageTracker): Promise<ReturnType<UsageTracker['snapshot']>> {
    let snap = tracker.snapshot();
    await vi.waitFor(() => {
      snap = tracker.snapshot();
      expect(snap.loading).toBeUndefined();
    });
    // One more round so today's count has landed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return tracker.snapshot();
  }

  it('counts the history on first use, saves it through yesterday, and counts today live without saving it', async () => {
    writeWire([record('2026-11-20', 'a/alpha', { inputOther: 100 }), record('2026-11-26', 'a/alpha', { inputCacheRead: 50 })], '2026-11-26');
    writeWire([record('2026-11-27', 'a/alpha', { output: 7 })], '2026-11-27');
    const tracker = new UsageTracker(() => {}, home, () => NOW);
    const first = tracker.snapshot();
    expect(first.loading).toBe(0);
    const snap = await settled(tracker);
    expect(snap.days.get('2026-11-20')?.tokens).toBe(100);
    expect(snap.days.get('2026-11-26')?.tokens).toBe(50);
    expect(snap.days.get('2026-11-27')?.tokens).toBe(7);
    const saved = JSON.parse(readFileSync(join(home, 'usage-ledger.json'), 'utf8')) as { computedThrough: string; days: Record<string, unknown> };
    expect(saved.computedThrough).toBe('2026-11-26');
    expect(Object.keys(saved.days).toSorted()).toEqual(['2026-11-20', '2026-11-26']);
    tracker.dispose();
  });

  it('shows what it has while counting, newest files first, with a growing fraction', async () => {
    writeWire([record('2026-11-01', 'a/m', { output: 1 })], '2026-11-01');
    writeWire([record('2026-11-25', 'a/m', { output: 2 })], '2026-11-25');
    const fractions: number[] = [];
    let tracker: UsageTracker;
    // eslint-disable-next-line prefer-const
    tracker = new UsageTracker(() => {
      const loading = tracker.snapshot().loading;
      if (loading !== undefined) fractions.push(loading);
    }, home, () => NOW);
    await settled(tracker);
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions).toEqual(fractions.toSorted((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
    tracker.dispose();
  });

  it('keeps counted days after the logs are gone, and reads only newer files the next time', async () => {
    const old = writeWire([record('2026-11-20', 'a/alpha', { output: 9 })], '2026-11-20');
    const tracker = new UsageTracker(() => {}, home, () => NOW);
    await settled(tracker);
    tracker.dispose();
    rmSync(old);

    // A later start (the next day) counts only what changed since.
    writeWire([record('2026-11-27', 'a/alpha', { output: 4 })], '2026-11-27');
    const next = new UsageTracker(() => {}, home, () => at('2026-11-28', 9));
    const snap = await settled(next);
    expect(snap.days.get('2026-11-20')?.tokens).toBe(9);
    expect(snap.days.get('2026-11-27')?.tokens).toBe(4);
    expect(loadLedger(home).computedThrough).toBe('2026-11-27');
    next.dispose();
  });

  it('two trackers counting at once end with the same numbers', async () => {
    writeWire([record('2026-11-20', 'a/alpha', { output: 9 }), record('2026-11-21', 'a/alpha', { output: 1 })], '2026-11-21');
    const a = new UsageTracker(() => {}, home, () => NOW);
    const b = new UsageTracker(() => {}, home, () => NOW);
    const [x, y] = await Promise.all([settled(a), settled(b)]);
    expect([...x.days]).toEqual([...y.days]);
    expect(loadLedger(home).days['2026-11-20']?.tokens).toBe(9);
    a.dispose();
    b.dispose();
  });

  it('has nothing to count and says so without failing', async () => {
    const tracker = new UsageTracker(() => {}, home, () => NOW);
    const snap = await settled(tracker);
    expect(snap.days.size).toBe(0);
    expect(loadLedger(home).computedThrough).toBe('2026-11-26');
    tracker.dispose();
  });
});

describe('summarizeUsage', () => {
  const today = '2026-11-27';
  const day = (tokens: number, extra: Partial<DayUsage> = {}): DayUsage => ({ tokens, input: tokens, cacheRead: 0, requests: 1, ...extra });
  const snapshot = (entries: Record<string, DayUsage>): Parameters<typeof summarizeUsage>[0] => ({ days: new Map(Object.entries(entries)), today });

  it('sums today, 7 and 30 days, counts active days and finds the streak', () => {
    const s = summarizeUsage(snapshot({
      '2026-11-27': day(10), '2026-11-26': day(20), '2026-11-25': day(30),
      '2026-11-20': day(40), '2026-11-01': day(50), '2026-10-01': day(60),
    }));
    expect(s.today).toBe(10);
    expect(s.last7).toBe(60);
    expect(s.last30).toBe(150);
    expect(s.activeDays).toBe(6);
    expect(s.streak).toBe(3);
  });

  it('keeps a streak alive through a day not used yet today', () => {
    const s = summarizeUsage(snapshot({ '2026-11-26': day(1), '2026-11-25': day(1), '2026-11-23': day(1) }));
    expect(s.streak).toBe(2);
    expect(summarizeUsage(snapshot({})).streak).toBe(0);
  });

  it('reads the cache share of the last 30 days, and nothing without input', () => {
    expect(summarizeUsage(snapshot({ '2026-11-26': day(100, { input: 100, cacheRead: 97 }) })).cacheHit).toBeCloseTo(0.97);
    expect(summarizeUsage(snapshot({})).cacheHit).toBeUndefined();
    // Older than 30 days does not count.
    expect(summarizeUsage(snapshot({ '2026-09-01': day(100, { input: 100, cacheRead: 100 }) })).cacheHit).toBeUndefined();
  });

  it('ranks the models of the last 30 days only, merging a model across days', () => {
    const s = summarizeUsage(snapshot({
      '2026-11-26': day(10, { models: { alpha: 6, beta: 4 } }),
      '2026-11-20': day(10, { models: { alpha: 5, gamma: 5 } }),
      '2026-09-01': day(500, { models: { retired: 500 } }),
    }));
    expect(s.models).toEqual([{ id: 'alpha', tokens: 11 }, { id: 'gamma', tokens: 5 }, { id: 'beta', tokens: 4 }]);
  });
});

describe('local date keys', () => {
  it('adds days across month ends and the date in a key matches the clock', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(localDateKey(new Date(2026, 10, 27, 23, 59).getTime())).toBe('2026-11-27');
    expect(localDateKey(new Date(2026, 10, 28, 0, 1).getTime())).toBe('2026-11-28');
  });
});
