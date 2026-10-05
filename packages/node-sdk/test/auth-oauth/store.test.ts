import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileOAuthCredentialStore } from '../../src/auth-oauth/store';
import type { OAuthCredential } from '../../src/auth-oauth/types';

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: 'oauth',
    access: 'access-token',
    refresh: 'refresh-token',
    expires: 1_700_000_000_000,
    ...overrides,
  };
}

describe('FileOAuthCredentialStore', () => {
  let dir: string;
  let store: FileOAuthCredentialStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-store-'));
    store = new FileOAuthCredentialStore(join(dir, 'oauth'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a credential with provider extras', () => {
    const input = credential({ email: 'user@example.com' } as Partial<OAuthCredential>);
    store.write('test-provider', input);
    expect(store.read('test-provider')).toEqual(input);
  });

  it('stores the credential file with 0600 permissions', () => {
    store.write('test-provider', credential());
    const mode = statSync(join(dir, 'oauth', 'test-provider.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns undefined for a missing credential', () => {
    expect(store.read('missing')).toBeUndefined();
  });

  it('reads a corrupt or foreign-shaped file as no credential', async () => {
    store.write('broken', credential());
    await writeFile(join(dir, 'oauth', 'broken.json'), 'not json', 'utf-8');
    expect(store.read('broken')).toBeUndefined();

    await writeFile(join(dir, 'oauth', 'broken.json'), '{"type":"oauth"}', 'utf-8');
    expect(store.read('broken')).toBeUndefined();

    await writeFile(join(dir, 'oauth', 'broken.json'), '"a string"', 'utf-8');
    expect(store.read('broken')).toBeUndefined();
  });

  it('deletes credentials and tolerates missing files', () => {
    store.write('test-provider', credential());
    store.delete('test-provider');
    expect(store.read('test-provider')).toBeUndefined();
    expect(() => {
      store.delete('test-provider');
    }).not.toThrow();
  });

  it('reads unsafe provider ids as no credential but rejects writing them', () => {
    expect(store.read('../escape')).toBeUndefined();
    expect(store.read('Custom.Provider')).toBeUndefined();
    expect(() => {
      store.write('../escape', credential());
    }).toThrow('Invalid OAuth provider id');
    expect(() => {
      store.delete('Custom.Provider');
    }).toThrow('Invalid OAuth provider id');
  });

  it('serializes concurrent modify calls per provider', async () => {
    store.write('test-provider', credential());
    const order: string[] = [];

    const first = store.modify('test-provider', async (current) => {
      order.push('first:enter');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first:exit');
      return { ...(current as OAuthCredential), access: 'first' };
    });
    const second = store.modify('test-provider', async (current) => {
      order.push(`second:enter(${(current as OAuthCredential).access})`);
      return (current as OAuthCredential).access === 'first' ? undefined : credential();
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter(first)']);
    // The second modify observed the first one's committed value and opted out.
    expect(store.read('test-provider')?.access).toBe('first');
  });

  it('leaves the stored value untouched when modify returns undefined', async () => {
    store.write('test-provider', credential({ access: 'keep' }));
    await store.modify('test-provider', async () => undefined);
    expect(store.read('test-provider')?.access).toBe('keep');
    expect(JSON.parse(await readFile(join(dir, 'oauth', 'test-provider.json'), 'utf-8'))).toEqual(
      credential({ access: 'keep' }),
    );
  });

  it('drops an in-flight write-back when the credential is deleted meanwhile', async () => {
    store.write('test-provider', credential({ access: 'stale' }));

    const refreshing = store.modify('test-provider', async (current) => {
      // Stands in for the network round-trip of a refresh.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ...(current as OAuthCredential), access: 'rotated' };
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    store.delete('test-provider');

    await expect(refreshing).resolves.toBeUndefined();
    // The logout wins: the refresh must not resurrect the credential.
    expect(store.read('test-provider')).toBeUndefined();
  });

  it('drops an in-flight write-back when a fresh credential is written meanwhile', async () => {
    store.write('test-provider', credential({ access: 'stale' }));

    const refreshing = store.modify('test-provider', async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ...(current as OAuthCredential), access: 'rotated-from-old-session' };
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    // Stands in for a login completed while the refresh was in flight.
    store.write('test-provider', credential({ access: 'fresh-login' }));

    await expect(refreshing).resolves.toBeUndefined();
    expect(store.read('test-provider')?.access).toBe('fresh-login');
  });
});
