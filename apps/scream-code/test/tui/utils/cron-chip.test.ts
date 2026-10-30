/**
 * `cron.fired` → status-chip copy.
 *
 * The chip is one terminal row: it must collapse a multi-line prompt, strip
 * control sequences (the prompt is model/tool-authored), cap its length, and
 * pick the most notable framing (stale > coalesced > one-shot > plain).
 */

import { describe, expect, it } from 'vitest';

import { buildCronReminderChip } from '#/tui/utils/cron-chip';
import type { CronFiredEvent } from '@scream-code/scream-code-sdk';

function fired(overrides: {
  prompt?: string;
  cron?: string;
  recurring?: boolean;
  coalescedCount?: number;
  stale?: boolean;
} = {}): CronFiredEvent {
  return {
    type: 'cron.fired',
    agentId: 'main',
    sessionId: 'ses-test',
    prompt: overrides.prompt ?? '检查 CI 构建状态',
    origin: {
      kind: 'cron_job',
      jobId: 'job-1',
      cron: overrides.cron ?? '*/5 * * * *',
      recurring: overrides.recurring ?? true,
      coalescedCount: overrides.coalescedCount ?? 1,
      stale: overrides.stale ?? false,
    },
  } as unknown as CronFiredEvent;
}

describe('buildCronReminderChip', () => {
  it('frames a plain recurring fire as the event itself', () => {
    expect(buildCronReminderChip(fired())).toEqual({
      text: '⏰ 定时任务已触发：检查 CI 构建状态',
      tone: 'fired',
    });
  });

  it('reports how many runs were merged', () => {
    expect(buildCronReminderChip(fired({ coalescedCount: 3 })).text).toBe(
      '⏰ 定时任务已触发（合并 3 次）：检查 CI 构建状态',
    );
  });

  it('names a one-time reminder as such', () => {
    expect(buildCronReminderChip(fired({ recurring: false })).text).toBe(
      '⏰ 一次性提醒已触发：检查 CI 构建状态',
    );
  });

  it('warns when an expired task still fired', () => {
    expect(buildCronReminderChip(fired({ stale: true, coalescedCount: 4 }))).toEqual({
      text: '⚠️ 定时任务已过期，仍触发：检查 CI 构建状态',
      tone: 'missed',
    });
  });

  it('collapses a multi-line prompt onto one row and strips control sequences', () => {
    const chip = buildCronReminderChip(
      fired({ prompt: '\u001B[31m第一行\n\n  第二行\u001B[0m' }),
    );
    expect(chip.text).toBe('⏰ 定时任务已触发：第一行 第二行');
  });

  it('falls back to the schedule when the prompt is empty', () => {
    expect(buildCronReminderChip(fired({ prompt: '   \n  ', cron: '0 9 * * 1-5' })).text).toBe(
      '⏰ 定时任务已触发：0 9 * * 1-5',
    );
  });

  it('caps the preview so the chip cannot swallow the row', () => {
    const chip = buildCronReminderChip(fired({ prompt: '甲'.repeat(120) }));
    const preview = chip.text.replace('⏰ 定时任务已触发：', '');
    expect(Array.from(preview)).toHaveLength(40);
    expect(preview.endsWith('…')).toBe(true);
  });
});
