/**
 * Tool friction over recent sessions, as numbers only — what the weekly
 * self-review looks at.
 *
 * Reads each recent session's main wire and keeps nothing of what was said:
 * per tool, how many calls and how many came back as errors; per skill, how
 * many times it was actually invoked (the `Skill` tool, not merely loaded);
 * and, per tool, the ids of the sessions with the most errors, so a proposal
 * can say where it saw the problem without quoting it. Arguments, results and
 * messages are parsed only to read those fields and are dropped at once.
 */

import { sharedMemoStore, type MemoryUseStats } from '@scream-code/memory';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export interface ToolFriction {
  readonly tool: string;
  readonly calls: number;
  readonly errors: number;
  /** Up to three session ids with the most errors from this tool. */
  readonly worstSessions: readonly string[];
}

export interface FrictionReport {
  readonly sinceMs: number;
  readonly sessions: number;
  readonly tools: readonly ToolFriction[];
  /** Skill name → times invoked. */
  readonly skillCalls: Readonly<Record<string, number>>;
  /**
   * How files got changed: successful Edit / Write calls, and shell commands
   * that changed a file the agent had read or edited (a Bash result carrying
   * `file_changes`). A rising shell share means edits are failing the agent.
   */
  readonly fileEdits: { readonly viaTools: number; readonly viaShell: number };
}

const WIRE_CANDIDATES = [join('agents', 'main', 'wire.jsonl'), 'wire.jsonl'] as const;
/** A wire larger than this is skipped: friction is a trend, not an audit. */
const MAX_WIRE_BYTES = 256 * 1024 * 1024;

async function recentWires(screamHomeDir: string, since: number): Promise<{ sessionId: string; path: string }[]> {
  const root = join(screamHomeDir, 'sessions');
  const found: { sessionId: string; path: string }[] = [];
  let groups: string[];
  try {
    groups = await readdir(root);
  } catch {
    return [];
  }
  for (const group of groups) {
    let ids: string[];
    try {
      ids = await readdir(join(root, group));
    } catch {
      continue;
    }
    for (const sessionId of ids) {
      for (const candidate of WIRE_CANDIDATES) {
        const path = join(root, group, sessionId, candidate);
        try {
          const info = await stat(path);
          if (info.isFile() && info.mtimeMs >= since && info.size <= MAX_WIRE_BYTES) found.push({ sessionId, path });
          break;
        } catch {
          // Try the next location.
        }
      }
    }
  }
  return found;
}

interface Counters {
  calls: number;
  errors: number;
  errorsBySession: Map<string, number>;
}

/**
 * Friction from `since` up to `until` (epoch ms; default: now), across every
 * session written to since `since`.
 */
export async function collectFriction(
  screamHomeDir: string,
  since: number,
  until: number = Number.POSITIVE_INFINITY,
): Promise<FrictionReport> {
  const counters = new Map<string, Counters>();
  const skillCalls: Record<string, number> = {};
  const fileEdits = { viaTools: 0, viaShell: 0 };
  const wires = await recentWires(screamHomeDir, since);
  for (const { sessionId, path } of wires) {
    const toolByCall = new Map<string, string>();
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('context.append_loop_event')) continue;
      let record: { type?: unknown; time?: unknown; event?: Record<string, unknown> };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      const event = record.event;
      if (record.type !== 'context.append_loop_event' || event === undefined) continue;
      // Records carry `time` in seconds or milliseconds depending on their age.
      const time = typeof record.time === 'number' ? (record.time < 1e12 ? record.time * 1000 : record.time) : undefined;
      if (time !== undefined && (time < since || time >= until)) continue;
      if (event['type'] === 'tool.call' && typeof event['name'] === 'string' && typeof event['toolCallId'] === 'string') {
        const tool = event['name'];
        toolByCall.set(event['toolCallId'], tool);
        const entry = counters.get(tool) ?? { calls: 0, errors: 0, errorsBySession: new Map() };
        entry.calls += 1;
        counters.set(tool, entry);
        if (tool === 'Skill') {
          const skill = (event['args'] as { skill?: unknown } | undefined)?.skill;
          if (typeof skill === 'string' && skill.length <= 100) skillCalls[skill] = (skillCalls[skill] ?? 0) + 1;
        }
      } else if (event['type'] === 'tool.result' && typeof event['toolCallId'] === 'string') {
        const tool = toolByCall.get(event['toolCallId']);
        const result = event['result'] as { isError?: unknown; display?: unknown } | undefined;
        const isError = result?.isError === true;
        if (!isError && (tool === 'Edit' || tool === 'Write')) fileEdits.viaTools += 1;
        // Only commands that hand-edited files count: git or a formatter
        // changing them is not an edit the agent should have made with Edit.
        const display = result?.display as { kind?: unknown; scripted?: unknown } | undefined;
        if (display?.kind === 'file_changes' && display.scripted === true) fileEdits.viaShell += 1;
        if (tool === undefined || !isError) continue;
        const entry = counters.get(tool);
        if (entry === undefined) continue;
        entry.errors += 1;
        entry.errorsBySession.set(sessionId, (entry.errorsBySession.get(sessionId) ?? 0) + 1);
      }
    }
  }
  const tools = [...counters.entries()]
    .map(([tool, entry]) => ({
      tool,
      calls: entry.calls,
      errors: entry.errors,
      worstSessions: [...entry.errorsBySession.entries()]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id),
    }))
    .toSorted((a, b) => b.errors - a.errors || b.calls - a.calls);
  return { sinceMs: since, sessions: wires.length, tools, skillCalls, fileEdits };
}

/**
 * How memories were used since `since`, numbers only (no memo text): what
 * the self-review needs to say which memories helped and which went unused.
 * Undefined when the memory store cannot be opened.
 */
export async function collectMemoryUse(
  screamHomeDir: string,
  since: number,
  idleBefore: number,
): Promise<MemoryUseStats | undefined> {
  try {
    const store = sharedMemoStore(screamHomeDir);
    await store.init();
    return await store.useStats(since, idleBefore);
  } catch {
    return undefined;
  }
}

/**
 * The block a self-review run is given: friction over the last week, which
 * of the person's own skills went unused for four weeks, and how memories
 * were used. Model-facing, so English. `userSkills` are the names of the
 * skills in `<home>/skills`.
 */
export function renderFrictionBlock(
  week: FrictionReport,
  month: FrictionReport,
  userSkills: readonly string[],
  /** The week before, to tell whether friction went down after last week's changes. */
  previousWeek?: FrictionReport,
  /** Memory use over the same week; "never recalled" counts memories older than a month. */
  memoryUse?: MemoryUseStats,
): string {
  const rateOf = (entry: { calls: number; errors: number }): number =>
    entry.calls === 0 ? 0 : Math.round((entry.errors / entry.calls) * 100);
  const lines = ['<tool-friction window="7 days">', `sessions: ${String(week.sessions)}`];
  for (const entry of week.tools.slice(0, 15)) {
    const rate = rateOf(entry);
    const before = previousWeek?.tools.find((candidate) => candidate.tool === entry.tool);
    const trend = before === undefined || before.calls === 0 ? '' : `; the week before ${String(rateOf(before))}%`;
    lines.push(
      `- ${entry.tool}: ${String(entry.calls)} calls, ${String(entry.errors)} errors (${String(rate)}%${trend})` +
        (entry.worstSessions.length === 0 ? '' : `; most in sessions ${entry.worstSessions.join(', ')}`),
    );
  }
  lines.push('</tool-friction>');
  const shellShare = (report: FrictionReport | undefined): number | undefined => {
    if (report === undefined) return undefined;
    const all = report.fileEdits.viaTools + report.fileEdits.viaShell;
    return all === 0 ? undefined : Math.round((report.fileEdits.viaShell / all) * 100);
  };
  const share = shellShare(week);
  if (share !== undefined) {
    const before = shellShare(previousWeek);
    lines.push(
      '<file-edits window="7 days">',
      `through Edit / Write: ${String(week.fileEdits.viaTools)}; shell commands that changed files the agent was editing: ` +
        `${String(week.fileEdits.viaShell)} (${String(share)}% of edits${before === undefined ? '' : `; the week before ${String(before)}%`})`,
      '</file-edits>',
    );
  }
  lines.push('<skill-use window="28 days">');
  const used = Object.entries(month.skillCalls).toSorted((a, b) => b[1] - a[1]);
  for (const [skill, count] of used.slice(0, 20)) lines.push(`- ${skill}: invoked ${String(count)} times`);
  const unused = userSkills.filter((skill) => month.skillCalls[skill] === undefined);
  if (unused.length > 0) lines.push(`- never invoked: ${unused.join(', ')}`);
  lines.push('</skill-use>');
  if (memoryUse !== undefined) {
    lines.push(
      '<memory-use window="7 days">',
      `memories: ${String(memoryUse.total)} (${String(memoryUse.added)} added this week)`,
      `recalled this week: ${String(memoryUse.recalled)}` +
        (memoryUse.topRecalled.length === 0
          ? ''
          : `; most: ${memoryUse.topRecalled.map((entry) => `${entry.id} (${String(entry.count)} times in all)`).join(', ')}`),
      `never recalled and older than 30 days: ${String(memoryUse.neverRecalledOld)}`,
      '</memory-use>',
    );
  }
  return lines.join('\n');
}
