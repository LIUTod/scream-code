import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLocale, setLocale, t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { handleTraceCommand } from '#/tui/commands/trace';

import { makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

function inLocale<T>(locale: 'en' | 'zh', fn: () => T): T {
  const previous = getLocale();
  setLocale(locale);
  try {
    return fn();
  } finally {
    setLocale(previous);
  }
}

describe('/trace', () => {
  it.each(['en', 'zh'] as const)('says why there is nothing to export without a session (%s)', async (locale) => {
    const host = makeMockSlashCommandHost();

    inLocale(locale, () => {
      handleTraceCommand(host);
    });

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(inLocale(locale, () => t('trace.err.no_session')));
    });
  });

  it('names the missing wire file in the UI language', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'scream-trace-'));
    const session = makeMockSession({ overrides: { summary: { sessionDir, title: 'demo' } } });
    const host = makeMockSlashCommandHost({ session });

    inLocale('en', () => {
      handleTraceCommand(host);
    });

    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(`Trace file not found: ${wirePath}`);
    });
  });

  it('has English and Chinese wording for every trace message', () => {
    for (const key of ['trace.err.no_session', 'trace.opened', 'trace.generated']) {
      expect(inLocale('en', () => t(key))).not.toMatch(/[一-鿿]/);
      expect(inLocale('zh', () => t(key))).toMatch(/[一-鿿]/);
    }
  });
});
