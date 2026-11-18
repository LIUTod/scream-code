/**
 * `localizedSubagentDesc` builds its key (`subagent.desc_<name>`) at runtime,
 * so a scan for literal `t('…')` keys cannot see these phrases are used. Pin
 * that every built-in subagent has its description in both locales, or a
 * cleanup of "unused" strings silently turns the UI back to English.
 */
import { getLocale, setLocale, t } from '@scream-code/config';
import { subagentRoster } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { localizedSubagentDesc } from '#/tui/utils/subagent-display';

const initialLocale = getLocale();
afterEach(() => {
  setLocale(initialLocale);
});

describe('localizedSubagentDesc', () => {
  it('has a translated description for every built-in subagent in both locales', () => {
    const names = subagentRoster().map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale);
      for (const name of names) {
        const key = `subagent.desc_${name}`;
        expect(t(key), `${locale}: ${key}`).not.toBe(key);
        expect(localizedSubagentDesc(name), `${locale}: ${name}`).toBe(t(key));
      }
    }
  });

  it('falls back to the profile description for a subagent with no phrase', () => {
    expect(localizedSubagentDesc('no-such-subagent')).toBe('no-such-subagent');
  });
});
