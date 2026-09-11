import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SCREAM_CODE_PLATFORM,
  assertScreamHostIdentity,
  createScreamDefaultHeaders,
  createScreamDeviceHeaders,
  createScreamDeviceId,
  createScreamUserAgent,
} from '../src/identity';
import { isRecord } from '../src/utils';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PRINTABLE_ASCII_RE = /^[\u0020-\u007E]+$/;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scream-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Directory may already be gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createScreamDeviceId', () => {
  it('generates a UUID on first call and persists it to device_id', () => {
    const home = makeTempHome();
    const id = createScreamDeviceId(home);
    expect(id).toMatch(UUID_RE);
    expect(readFileSync(join(home, 'device_id'), 'utf-8')).toBe(id);
  });

  it('reuses the persisted id on subsequent calls and honours file content', () => {
    const home = makeTempHome();
    const first = createScreamDeviceId(home);
    expect(createScreamDeviceId(home)).toBe(first);
    writeFileSync(join(home, 'device_id'), 'external-id-42', 'utf-8');
    expect(createScreamDeviceId(home)).toBe('external-id-42');
  });

  it('regenerates when the file is empty or whitespace only', () => {
    const home = makeTempHome();
    writeFileSync(join(home, 'device_id'), '   \n\t ', 'utf-8');
    const id = createScreamDeviceId(home);
    expect(id).toMatch(UUID_RE);
    expect(readFileSync(join(home, 'device_id'), 'utf-8')).toBe(id);
  });

  // Running as root would ignore directory permissions, so skip there.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'returns an in-memory id without throwing when the home dir is not writable',
    () => {
      const parent = makeTempHome();
      const home = join(parent, 'locked');
      mkdirSync(home, { mode: 0o700 });
      chmodSync(home, 0o500);
      try {
        const id = createScreamDeviceId(home);
        expect(id).toMatch(UUID_RE);
        expect(existsSync(join(home, 'device_id'))).toBe(false);
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );
});

describe('createScreamUserAgent', () => {
  it('renders "product/version" without a suffix', () => {
    expect(createScreamUserAgent({ userAgentProduct: 'scream-cli', version: '1.2.3' })).toBe(
      'scream-cli/1.2.3',
    );
  });

  it('renders "product/version (suffix)" when a suffix is given', () => {
    expect(
      createScreamUserAgent({
        userAgentProduct: 'scream-cli',
        version: '1.2.3',
        userAgentSuffix: 'beta.1',
      }),
    ).toBe('scream-cli/1.2.3 (beta.1)');
  });

  it('cleans non-ASCII from the suffix; a suffix cleaning to empty equals no suffix', () => {
    expect(
      createScreamUserAgent({
        userAgentProduct: 'scream-cli',
        version: '1.2.3',
        userAgentSuffix: '中文品牌',
      }),
    ).toBe('scream-cli/1.2.3');
    expect(
      createScreamUserAgent({
        userAgentProduct: 'scream-cli',
        version: '1.2.3',
        userAgentSuffix: 'be ta中文',
      }),
    ).toBe('scream-cli/1.2.3 (be ta)');
  });

  it.each([
    { label: 'empty product', options: { userAgentProduct: '', version: '1.0.0' } },
    { label: 'non-ASCII product', options: { userAgentProduct: '尖叫', version: '1.0.0' } },
    { label: 'empty version', options: { userAgentProduct: 'scream-cli', version: '' } },
    { label: 'non-ASCII version', options: { userAgentProduct: 'scream-cli', version: '版本' } },
  ])('throws for $label', ({ options }) => {
    expect(() => createScreamUserAgent(options)).toThrow(/must be a non-empty ASCII string/);
  });
});

describe('createScreamDeviceHeaders', () => {
  it('produces all six X-Msh-* headers with printable ASCII values', () => {
    const home = makeTempHome();
    const headers = createScreamDeviceHeaders({ homeDir: home, version: '9.9.9' });
    expect(Object.keys(headers).toSorted()).toEqual([
      'X-Msh-Device-Id',
      'X-Msh-Device-Model',
      'X-Msh-Device-Name',
      'X-Msh-Os-Version',
      'X-Msh-Platform',
      'X-Msh-Version',
    ]);
    for (const value of Object.values(headers)) {
      expect(value).toMatch(PRINTABLE_ASCII_RE);
    }
    expect(headers['X-Msh-Platform']).toBe(SCREAM_CODE_PLATFORM);
    expect(headers['X-Msh-Version']).toBe('9.9.9');
    expect(headers['X-Msh-Device-Id']).toMatch(UUID_RE);
  });

  it('reuses the persisted device id file', () => {
    const home = makeTempHome();
    writeFileSync(join(home, 'device_id'), 'stable-id', 'utf-8');
    const headers = createScreamDeviceHeaders({ homeDir: home, version: '1.0' });
    expect(headers['X-Msh-Device-Id']).toBe('stable-id');
  });
});

describe('createScreamDefaultHeaders', () => {
  it('combines User-Agent with the six device headers', () => {
    const home = makeTempHome();
    const headers = createScreamDefaultHeaders({
      userAgentProduct: 'scream-cli',
      version: '2.0.0',
      homeDir: home,
    });
    expect(headers['User-Agent']).toBe('scream-cli/2.0.0');
    expect(Object.keys(headers)).toHaveLength(7);
    for (const value of Object.values(headers)) {
      expect(value).toMatch(PRINTABLE_ASCII_RE);
    }
  });
});

describe('assertScreamHostIdentity', () => {
  it('returns a valid identity unchanged', () => {
    const identity = { userAgentProduct: 'scream-cli', version: '1.0.0' };
    expect(assertScreamHostIdentity(identity)).toBe(identity);
  });

  it('throws when identity is undefined', () => {
    expect(() => assertScreamHostIdentity(undefined)).toThrow(/host identity is required/i);
  });

  it('throws when product or version is not usable ASCII', () => {
    expect(() =>
      assertScreamHostIdentity({ userAgentProduct: '尖叫', version: '1.0.0' }),
    ).toThrow(/product must be a non-empty ASCII string/);
    expect(() =>
      assertScreamHostIdentity({ userAgentProduct: 'scream-cli', version: '' }),
    ).toThrow(/version must be a non-empty ASCII string/);
  });
});

describe('isRecord', () => {
  it.each([
    ['plain object', {}, true],
    ['nested object', { a: { b: 1 } }, true],
    ['array', [1, 2], false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['string', 'x', false],
    ['number', 42, false],
    ['boolean', true, false],
  ])('is %j for %s', (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});
