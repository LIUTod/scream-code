/**
 * Per-day token usage for the session-status sidebar, counted from the session
 * logs and kept in `<dataDir>/usage-ledger.json`.
 *
 * Every request a session makes is a `usage.record` line in its `wire.jsonl`
 * (time, model, tokens per bucket). The ledger folds them into one entry per
 * local day. Days up to yesterday are frozen once counted and never read again
 * (`computedThrough` says how far); today is counted live from the files that
 * changed today and is never saved. So:
 *
 *  - the first open counts the whole history in the background, newest files
 *    first, and shows what it has so far;
 *  - later opens read only the files touched since the last count;
 *  - two terminals counting at once get the same numbers (a day is recounted
 *    from the logs, not added to), so the file needs no merging;
 *  - days already counted survive the logs being deleted.
 *
 * A record that carries `fold` re-records a finished subagent's usage into its
 * parent; the child's own log already has it, so it is not counted again.
 * Per-model detail is kept for the last {@link MODEL_DETAIL_DAYS} days and at
 * most {@link MODEL_DETAIL_LIMIT} models a day (the rest are folded into
 * `other`), so the file stays small however often models are added and removed.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SCREAM_CODE_USAGE_LEDGER_FILE_NAME } from '#/constant/app';
import { getDataDir } from '#/utils/paths';

export const LEDGER_VERSION = 1;
export const MODEL_DETAIL_DAYS = 90;
export const MODEL_DETAIL_LIMIT = 20;
/** Models seen in a day beyond the limit are summed under this key. */
export const OTHER_MODELS = '\u0000other';
/** Today is recounted at most this often while the sidebar is open. */
const TODAY_REFRESH_MS = 30_000;

export interface DayUsage {
  /** Everything: input (cache reads included) and output. */
  tokens: number;
  /** Input tokens, cache reads and writes included. */
  input: number;
  /** Input tokens served from the cache. */
  cacheRead: number;
  requests: number;
  /** Tokens per model id; only kept for recent days. */
  models?: Record<string, number>;
}

export interface LedgerFile {
  version: number;
  /** The last day (`YYYY-MM-DD`) whose entry is complete, or null before the first count. */
  computedThrough: string | null;
  days: Record<string, DayUsage>;
}

export function emptyLedger(): LedgerFile {
  return { version: LEDGER_VERSION, computedThrough: null, days: {} };
}

const pad = (n: number): string => String(n).padStart(2, '0');
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function startOfDay(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}
export function addDays(key: string, days: number): string {
  const d = new Date(startOfDay(key));
  d.setDate(d.getDate() + days);
  return localDateKey(d.getTime());
}

/**
 * The model a request ran on, named by its id alone: the recorded key is
 * `<provider>/<model id>` and the provider part is whatever alias the person
 * gave it, so the same model reached through two aliases is one model.
 */
export function normalizeModelId(key: string): string {
  const afterProvider = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
  const last = afterProvider.slice(afterProvider.lastIndexOf('/') + 1);
  return last === '' ? key : last;
}

function emptyDay(): DayUsage {
  return { tokens: 0, input: 0, cacheRead: 0, requests: 0, models: {} };
}

function ledgerPath(homeDir: string): string {
  return join(homeDir, SCREAM_CODE_USAGE_LEDGER_FILE_NAME);
}

function validDay(value: unknown): value is DayUsage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['tokens', 'input', 'cacheRead', 'requests'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

/** Read the ledger. A missing, unreadable or foreign file is an empty ledger: it is only a cache of the logs. */
export function loadLedger(homeDir: string): LedgerFile {
  try {
    const file = ledgerPath(homeDir);
    if (!existsSync(file)) return emptyLedger();
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerFile>;
    if (parsed.version !== LEDGER_VERSION || typeof parsed.days !== 'object' || parsed.days === null) return emptyLedger();
    const days: Record<string, DayUsage> = {};
    for (const [key, day] of Object.entries(parsed.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && validDay(day)) days[key] = day;
    }
    const through = typeof parsed.computedThrough === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.computedThrough) ? parsed.computedThrough : null;
    return { version: LEDGER_VERSION, computedThrough: through, days };
  } catch {
    return emptyLedger();
  }
}

/** Write through a temporary file and rename, so a crash never leaves half a ledger. Best effort. */
export function saveLedger(homeDir: string, ledger: LedgerFile): void {
  try {
    const file = ledgerPath(homeDir);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${String(process.pid)}.tmp`;
    writeFileSync(temp, JSON.stringify(ledger), 'utf8');
    renameSync(temp, file);
  } catch {
    // The count is rebuilt from the logs next time.
  }
}

/** Keep the file small: per-model detail only for recent days, and a bounded list per day. */
export function pruneLedger(ledger: LedgerFile, todayKey: string): void {
  const cutoff = addDays(todayKey, -MODEL_DETAIL_DAYS);
  for (const [key, day] of Object.entries(ledger.days)) {
    if (key < cutoff) {
      delete day.models;
      continue;
    }
    if (day.models === undefined) continue;
    const entries = Object.entries(day.models).toSorted((a, b) => b[1] - a[1]);
    if (entries.length <= MODEL_DETAIL_LIMIT) continue;
    const kept = entries.slice(0, MODEL_DETAIL_LIMIT - 1);
    const rest = entries.slice(MODEL_DETAIL_LIMIT - 1).reduce((sum, [, tokens]) => sum + tokens, 0);
    day.models = { ...Object.fromEntries(kept), [OTHER_MODELS]: rest };
  }
}

interface WireUsage {
  inputOther?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
  output?: number;
}

/** The days a single `wire.jsonl` line counts toward, or nothing if it is not a fresh usage record. */
function countLine(line: string, from: string | undefined, to: string | undefined, days: Map<string, DayUsage>): void {
  if (!line.includes('"usage.record"')) return;
  let record: { type?: string; time?: number; model?: string; usage?: WireUsage; fold?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return;
  }
  if (record.type !== 'usage.record' || record.fold !== undefined || typeof record.time !== 'number') return;
  const key = localDateKey(record.time > 1e12 ? record.time : record.time * 1000);
  if ((from !== undefined && key < from) || (to !== undefined && key > to)) return;
  const u = record.usage ?? {};
  const input = (u.inputOther ?? 0) + (u.inputCacheRead ?? 0) + (u.inputCacheCreation ?? 0);
  const output = u.output ?? 0;
  let day = days.get(key);
  if (day === undefined) {
    day = emptyDay();
    days.set(key, day);
  }
  day.tokens += input + output;
  day.input += input;
  day.cacheRead += u.inputCacheRead ?? 0;
  day.requests += 1;
  const id = normalizeModelId(typeof record.model === 'string' ? record.model : '?');
  day.models![id] = (day.models![id] ?? 0) + input + output;
}

async function readLines(file: string, onLine: (line: string) => void): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let rest = '';
  for await (const chunk of stream as AsyncIterable<string>) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) onLine(line);
  }
  if (rest !== '') onLine(rest);
}

/** Every `agents/<id>/wire.jsonl` under `<sessionsDir>/<workdir>/<session>/`, with its mtime, newest first. */
export async function listWireFiles(sessionsDir: string, sinceMs: number): Promise<Array<{ file: string; mtimeMs: number }>> {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  const dirs = async (path: string): Promise<string[]> => {
    try {
      return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const workdir of await dirs(sessionsDir)) {
    for (const session of await dirs(join(sessionsDir, workdir))) {
      const agentsDir = join(sessionsDir, workdir, session, 'agents');
      for (const agent of await dirs(agentsDir)) {
        const file = join(agentsDir, agent, 'wire.jsonl');
        try {
          const info = await stat(file);
          if (info.mtimeMs >= sinceMs) found.push({ file, mtimeMs: info.mtimeMs });
        } catch {
          // No log for this agent.
        }
      }
    }
  }
  return found.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface ScanOptions {
  sessionsDir: string;
  /** Only files changed at or after this time can hold records of the days asked for. */
  sinceMs: number;
  /** Inclusive local dates (`YYYY-MM-DD`); either end may be left open. */
  from?: string;
  to?: string;
  /** Called after each file with the days counted so far (they are still growing) and how far along it is. */
  onProgress?: (days: ReadonlyMap<string, DayUsage>, done: number, total: number) => void;
}

/** Count the usage records of the days asked for. Never throws: an unreadable file is skipped. */
export async function scanUsage(options: ScanOptions): Promise<Map<string, DayUsage>> {
  const days = new Map<string, DayUsage>();
  const files = await listWireFiles(options.sessionsDir, options.sinceMs);
  let done = 0;
  for (const { file } of files) {
    try {
      await readLines(file, (line) => { countLine(line, options.from, options.to, days); });
    } catch {
      // A log that vanished or cannot be read counts for nothing.
    }
    done++;
    options.onProgress?.(days, done, files.length);
    // Let a frame through between files: a long history must not stall the UI.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return days;
}

export interface UsageSnapshot {
  readonly days: ReadonlyMap<string, DayUsage>;
  /** Local date of "today". */
  readonly today: string;
  /** While the history is being counted: how far along it is, 0..1. */
  readonly loading?: number;
}

/**
 * Owns the ledger for one process: counts the history in the background the
 * first time it is asked, keeps today fresh, and hands the sidebar a snapshot.
 */
export class UsageTracker {
  private ledger: LedgerFile | undefined;
  private todayDay: { key: string; day: DayUsage | undefined } | undefined;
  private todayAt = 0;
  private backfilling = false;
  private progress: { days: ReadonlyMap<string, DayUsage>; fraction: number } | undefined;
  private todayRunning = false;
  private disposed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly homeDir: string = getDataDir(),
    private readonly now: () => number = Date.now,
  ) {}

  private get sessionsDir(): string {
    return join(this.homeDir, 'sessions');
  }

  /** Called on every frame the sidebar draws; cheap, and starts whatever work is due. */
  snapshot(): UsageSnapshot {
    const today = localDateKey(this.now());
    this.ledger ??= loadLedger(this.homeDir);
    const yesterday = addDays(today, -1);
    if (!this.backfilling && (this.ledger.computedThrough === null || this.ledger.computedThrough < yesterday)) {
      void this.backfill(today);
    }
    if (this.now() - this.todayAt >= TODAY_REFRESH_MS || this.todayDay?.key !== today) void this.refreshToday(today);

    const days = new Map<string, DayUsage>();
    if (this.progress !== undefined) for (const [key, day] of this.progress.days) days.set(key, day);
    for (const [key, day] of Object.entries(this.ledger.days)) days.set(key, day);
    if (this.todayDay?.key === today && this.todayDay.day !== undefined) days.set(today, this.todayDay.day);
    return {
      days,
      today,
      ...(this.backfilling ? { loading: this.progress?.fraction ?? 0 } : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  private async backfill(today: string): Promise<void> {
    this.backfilling = true;
    const ledger = this.ledger!;
    const yesterday = addDays(today, -1);
    const from = ledger.computedThrough === null ? undefined : addDays(ledger.computedThrough, 1);
    try {
      const counted = await scanUsage({
        sessionsDir: this.sessionsDir,
        sinceMs: from === undefined ? 0 : startOfDay(from),
        ...(from === undefined ? {} : { from }),
        to: yesterday,
        onProgress: (days, done, total) => {
          if (this.disposed) return;
          this.progress = { days, fraction: total === 0 ? 1 : done / total };
          this.onChange();
        },
      });
      if (this.disposed) return;
      // Days in the range are replaced, never added to: counting twice gives the same answer.
      for (const [key, day] of counted) ledger.days[key] = day;
      ledger.computedThrough = yesterday;
      pruneLedger(ledger, today);
      saveLedger(this.homeDir, ledger);
    } catch {
      // Best effort: the next frame tries again.
    } finally {
      this.backfilling = false;
      this.progress = undefined;
      this.onChange();
    }
  }

  private async refreshToday(today: string): Promise<void> {
    if (this.todayRunning) return;
    this.todayRunning = true;
    this.todayAt = this.now();
    try {
      const counted = await scanUsage({ sessionsDir: this.sessionsDir, sinceMs: startOfDay(today), from: today, to: today });
      if (this.disposed) return;
      this.todayDay = { key: today, day: counted.get(today) };
      this.onChange();
    } catch {
      // Keep the previous count.
    } finally {
      this.todayRunning = false;
    }
  }
}

// ── what the sidebar shows, computed from a snapshot ──

export interface UsageSummary {
  readonly today: number;
  readonly last7: number;
  readonly last30: number;
  /** Share of the last 30 days' input served from the cache, or undefined without input. */
  readonly cacheHit: number | undefined;
  readonly activeDays: number;
  readonly streak: number;
  /** Models of the last 30 days, biggest first. */
  readonly models: ReadonlyArray<{ readonly id: string; readonly tokens: number }>;
}

export function summarizeUsage(snapshot: UsageSnapshot): UsageSummary {
  const sum = (back: number, pick: (d: DayUsage) => number): number => {
    let total = 0;
    for (let i = 0; i < back; i++) {
      const day = snapshot.days.get(addDays(snapshot.today, -i));
      if (day !== undefined) total += pick(day);
    }
    return total;
  };
  const input30 = sum(30, (d) => d.input);
  const models = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const day = snapshot.days.get(addDays(snapshot.today, -i));
    for (const [id, tokens] of Object.entries(day?.models ?? {})) models.set(id, (models.get(id) ?? 0) + tokens);
  }
  let streak = 0;
  let cursor = snapshot.today;
  // A day without use yet today does not break the streak.
  if ((snapshot.days.get(cursor)?.tokens ?? 0) === 0) cursor = addDays(cursor, -1);
  while ((snapshot.days.get(cursor)?.tokens ?? 0) > 0) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return {
    today: sum(1, (d) => d.tokens),
    last7: sum(7, (d) => d.tokens),
    last30: sum(30, (d) => d.tokens),
    cacheHit: input30 > 0 ? sum(30, (d) => d.cacheRead) / input30 : undefined,
    activeDays: [...snapshot.days.values()].filter((d) => d.tokens > 0).length,
    streak,
    models: [...models].map(([id, tokens]) => ({ id, tokens })).toSorted((a, b) => b.tokens - a.tokens),
  };
}

