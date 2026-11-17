/**
 * The system prompt's clock is local time with its zone, not UTC: the model
 * reads "today" and the hour off it (and writes local cron fields from it), so
 * a bare `…Z` string handed it the wrong date anywhere but UTC+0.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../../src/profile';

const ORIGINAL_TZ = process.env['TZ'];
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env['TZ'];
  else process.env['TZ'] = ORIGINAL_TZ;
});

const osEnv = {
  osKind: 'macOS',
  osArch: 'arm64',
  osVersion: '0',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;

function render(now?: string | Date): string {
  const profile = DEFAULT_AGENT_PROFILES['agent'];
  if (profile === undefined) throw new Error('default agent profile is missing');
  return profile.systemPrompt({ osEnv, cwd: '/workspace', ...(now === undefined ? {} : { now }) });
}

describe('system prompt clock', () => {
  it('renders local time with offset and zone, and says it does not advance', () => {
    process.env['TZ'] = 'Asia/Shanghai';
    const prompt = render(new Date(Date.UTC(2026, 10, 17, 20, 0)));
    expect(prompt).toContain(
      'The local date and time when this session was opened (started or resumed) was `2026-11-18T04:00:00+08:00, time zone Asia/Shanghai (UTC+08:00)`.',
    );
    expect(prompt).toContain('it does not advance during the session');
    expect(prompt).not.toContain('2026-11-17T20:00:00.000Z');
  });

  it('uses the current local time when no time is given', () => {
    process.env['TZ'] = 'America/New_York';
    expect(render()).toMatch(/was `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00, time zone America\/New_York \(UTC-0[45]:00\)`/);
  });

  it('keeps a caller-supplied string verbatim (tests pin the prompt this way)', () => {
    expect(render('2026-05-09T00:00:00.000Z')).toContain('was `2026-05-09T00:00:00.000Z`');
  });
});
