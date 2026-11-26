import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commandUsageWeight,
  mostUsedCommands,
  recordCommandUse,
  resetCommandUsage,
} from '#/tui/utils/command-usage';

const DAY = 86_400_000;
let home: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env['SCREAM_CODE_HOME'];
  home = mkdtempSync(join(tmpdir(), 'scream-usage-'));
  process.env['SCREAM_CODE_HOME'] = home;
  resetCommandUsage();
});

afterEach(() => {
  if (previous === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = previous;
  rmSync(home, { recursive: true, force: true });
  resetCommandUsage();
});

describe('command usage', () => {
  it('weighs a command by how often and how lately it ran', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    recordCommandUse('model', now);
    recordCommandUse('model', now);
    recordCommandUse('plan', now);
    expect(commandUsageWeight('model', now)).toBeCloseTo(2);
    expect(commandUsageWeight('plan', now)).toBeCloseTo(1);
    expect(commandUsageWeight('never', now)).toBe(0);
  });

  it('lets a command fade: its weight halves every fourteen days', () => {
    const then = Date.parse('2026-10-01T00:00:00Z');
    recordCommandUse('compact', then);
    expect(commandUsageWeight('compact', then + 14 * DAY)).toBeCloseTo(0.5);
    expect(commandUsageWeight('compact', then + 28 * DAY)).toBeCloseTo(0.25);
  });

  it('lists the most used of the candidates, heaviest first, and only those that ran', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    for (let i = 0; i < 3; i++) recordCommandUse('model', now);
    recordCommandUse('new', now);
    recordCommandUse('plan', now - 60 * DAY);
    expect(mostUsedCommands(['new', 'model', 'help', 'plan'], 5, now)).toEqual(['model', 'new', 'plan']);
    expect(mostUsedCommands(['new', 'model', 'plan'], 2, now)).toEqual(['model', 'new']);
    expect(mostUsedCommands(['help'], 5, now)).toEqual([]);
  });

  it('keeps what it learned across a restart', () => {
    recordCommandUse('model', 1_000);
    const saved = JSON.parse(readFileSync(join(home, 'command-usage.json'), 'utf8')) as Record<string, unknown>;
    expect(saved['model']).toEqual({ count: 1, last: 1_000 });
    resetCommandUsage();
    expect(commandUsageWeight('model', 1_000)).toBeCloseTo(1);
  });

  it('starts over from a corrupt file instead of failing', () => {
    writeFileSync(join(home, 'command-usage.json'), '{not json', 'utf8');
    expect(commandUsageWeight('model')).toBe(0);
    expect(() => {
      recordCommandUse('model');
    }).not.toThrow();
    expect(commandUsageWeight('model')).toBeGreaterThan(0);
  });

  it('ignores an empty name', () => {
    recordCommandUse('');
    expect(mostUsedCommands([''])).toEqual([]);
  });

  it("keeps what another terminal recorded in between, instead of writing over it", () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    recordCommandUse('model', now);
    // Another terminal ran /plan five times after this one loaded the file.
    const file = join(home, 'command-usage.json');
    const theirs = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { count: number; last: number }>;
    theirs['plan'] = { count: 5, last: now };
    writeFileSync(file, JSON.stringify(theirs), 'utf8');

    recordCommandUse('model', now);

    resetCommandUsage();
    expect(commandUsageWeight('plan', now)).toBeCloseTo(5);
    expect(commandUsageWeight('model', now)).toBeCloseTo(2);
  });
});
