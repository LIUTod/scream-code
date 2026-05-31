import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildScreamDefaultHeaders,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/scream-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith('/apps/scream-code/package.json')).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('builds default headers with the scream-code-cli user-agent', () => {
    const headers = buildScreamDefaultHeaders('1.2.3');

    expect(headers['User-Agent']).toBe('scream-code-cli/1.2.3');
  });
});
