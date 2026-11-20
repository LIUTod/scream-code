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
