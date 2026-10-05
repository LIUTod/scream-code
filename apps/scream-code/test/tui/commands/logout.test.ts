/**
 * `/logout` — provider removal plus OAuth credential cleanup.
 *
 * Provider keys come from `config.toml` and are arbitrary strings, while the
 * credential store only handles ids that can name a file. These tests drive the
 * command through the real `OAuthLoginService` so the id handling of the store
 * is what the picker and the removal path actually see.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import { OAuthLoginService } from '@scream-code/scream-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLogoutCommand } from '#/tui/commands/auth';

import { makeMockHarness, makeMockSlashCommandHost } from '../fixtures/mock-host';

/** The picker keeps its callbacks on a private field; this is the seam. */
interface PickerHandle {
  opts: { onSelect(value: string): void; onCancel(): void; options: Array<{ value: string }> };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('/logout provider selection', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'logout-command-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function makeHost(providers: Record<string, Record<string, unknown>>) {
    const service = new OAuthLoginService({ homeDir });
    const mounted: unknown[] = [];
    const removeProvider = vi.fn(async (providerId: string) => {
      delete providers[providerId];
      return { providers, models: {}, defaultModel: 'x', defaultThinking: false };
    });
    const harness = makeMockHarness({
      auth: {
        listOAuthProviders: () => service.listProviders(),
        hasOAuthCredential: (providerId: string) => service.hasCredential(providerId),
        logoutOAuthProvider: (providerId: string) => {
          service.logout(providerId);
        },
      },
      getConfig: vi.fn(async () => ({
        providers: structuredClone(providers),
        models: {},
        defaultModel: 'x',
        defaultThinking: false,
      })),
      removeProvider,
    });
    const host = makeMockSlashCommandHost({ harness: harness as never });
    (host as { mountEditorReplacement: (component: unknown) => void }).mountEditorReplacement = (
      component,
    ) => {
      mounted.push(component);
    };
    (host as { authFlow: unknown }).authFlow = {
      refreshConfigAfterLogout: vi.fn(async () => {}),
      clearActiveSessionAfterLogout: vi.fn(async () => {}),
    };
    return { host, mounted, removeProvider };
  }

  function mountedPicker(mounted: unknown[]): PickerHandle {
    expect(mounted).toHaveLength(1);
    return mounted[0] as PickerHandle;
  }

  it('lists a config key that cannot name a credential file and removes its entry', async () => {
    // `/config diy` keeps dots and case in the provider key.
    const { host, mounted, removeProvider } = makeHost({
      'custom-GPT-4.1': { type: 'openai', baseUrl: 'https://custom.example/v1' },
    });

    const run = handleLogoutCommand(host);
    await tick();

    const picker = mountedPicker(mounted);
    expect(picker.opts.options.map((option) => option.value)).toEqual(['custom-GPT-4.1']);

    picker.opts.onSelect('custom-GPT-4.1');
    await expect(run).resolves.toBeUndefined();

    expect(removeProvider).toHaveBeenCalledWith('custom-GPT-4.1');
    expect(host.showStatus).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('clears the stored credential for a provider that has one', async () => {
    const { host, mounted, removeProvider } = makeHost({
      openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
    });
    await mkdir(join(homeDir, 'oauth'), { recursive: true });
    const credentialPath = join(homeDir, 'oauth', 'openrouter.json');
    await writeFile(
      credentialPath,
      JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }),
      'utf-8',
    );

    const run = handleLogoutCommand(host);
    await tick();
    mountedPicker(mounted).opts.onSelect('openrouter');
    await run;

    expect(existsSync(credentialPath)).toBe(false);
    expect(removeProvider).toHaveBeenCalledWith('openrouter');
  });

  it('clears an orphan credential without claiming a provider entry was deleted', async () => {
    // The credential outlived its config entry (the entry was removed or the
    // config was rewritten); /logout still has to find and clear it.
    const { host, mounted, removeProvider } = makeHost({});
    await mkdir(join(homeDir, 'oauth'), { recursive: true });
    const credentialPath = join(homeDir, 'oauth', 'openrouter.json');
    await writeFile(
      credentialPath,
      JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }),
      'utf-8',
    );

    const run = handleLogoutCommand(host);
    await tick();
    const picker = mountedPicker(mounted);
    expect(picker.opts.options.map((option) => option.value)).toEqual(['openrouter']);

    picker.opts.onSelect('openrouter');
    await run;

    expect(existsSync(credentialPath)).toBe(false);
    expect(removeProvider).not.toHaveBeenCalled();
    // Reporting "Deleted provider" here would name a removal that never
    // happened: there was no provider entry.
    expect(host.showStatus).toHaveBeenCalledWith(
      t('auth.credential_removed', { name: 'openrouter' }),
    );
    expect(host.showStatus).not.toHaveBeenCalledWith(t('auth.deleted', { name: 'openrouter' }));
  });
});
