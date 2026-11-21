import { describe, expect, it } from 'vitest';

import { t } from '@scream-code/config';

import { serviceSummaryLines, type ServiceSummary } from '#/host/service-summary';

const STATUS = { manager: 'launchd', installed: true } as const;

function summary(overrides: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    status: STATUS,
    running: true,
    startedAt: 1_000,
    channel: undefined,
    keepAwake: true,
    tokensToday: 0,
    dailyTokenLimit: 0,
    ...overrides,
  };
}

describe('serviceSummaryLines — lid caveat', () => {
  it('explains the lid on a machine that has a battery', () => {
    expect(serviceSummaryLines(summary({ hasBattery: true }), 61_000)).toContain(t('service.keep_awake_note'));
  });

  it('stays quiet on a desktop, when a battery cannot be read, and with keep-awake off', () => {
    const note = t('service.keep_awake_note');
    expect(serviceSummaryLines(summary({ hasBattery: false }), 61_000)).not.toContain(note);
    expect(serviceSummaryLines(summary({}), 61_000)).not.toContain(note);
    expect(serviceSummaryLines(summary({ keepAwake: false, hasBattery: true }), 61_000)).not.toContain(note);
  });

  it('describes a condition, never a hardware product or brand', () => {
    // Product-level copy: the panel must not read as if it were written for one
    // particular machine, and must not name another company's hardware.
    expect(t('service.keep_awake_note')).not.toMatch(/macbook|imac|mac mini|mac studio|thinkpad|surface|苹果/iu);
  });
});

describe('serviceSummaryLines — build drift', () => {
  const restartHint = 'scream host restart';

  it('names both builds when the running host is older than the install', () => {
    const lines = serviceSummaryLines(
      summary({ runningVersion: '0.21.1', installedVersion: '0.21.2' }),
      0,
    );
    expect(lines).toContain(
      t('service.stale_build', { running: '0.21.1', installed: '0.21.2' }),
    );
    expect(lines.join('\n')).toContain(restartHint);
  });

  it('says plainly when the running host cannot name its build', () => {
    // A host started before the version stamp existed: it may well be the
    // installed build, so name what is unknown instead of guessing "old".
    const lines = serviceSummaryLines(summary({ installedVersion: '0.21.2' }), 0);
    expect(lines).toContain(t('service.build_unstamped', { installed: '0.21.2' }));
  });

  it('stays quiet when the builds match or nothing runs', () => {
    for (const value of [
      summary({ runningVersion: '0.21.2', installedVersion: '0.21.2' }),
      summary({ running: false, installedVersion: '0.21.2' }),
      summary({}),
    ]) {
      expect(serviceSummaryLines(value, 0).join('\n')).not.toContain(restartHint);
    }
  });
});
