import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const scriptPath = join(repoRoot, 'build/nix/update-pnpm-deps.sh');

const currentHash = 'sha256-LZ9Bkm3pG2ib7NcdqcP/kmoYWsNjXQ8PoEIlg/94oVo=';
const fakeHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const newHash = 'sha256-NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN=';

const tempRoots: string[] = [];

describe('update-pnpm-deps.sh', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('exits without patching fakeHash when the current pnpmDeps hash still builds', async () => {
    const fixture = await createFixtureRepo(currentHash);
    const result = await runUpdateScript(fixture, { currentValid: true });

    await expect(readFile(join(fixture.root, 'flake.nix'), 'utf-8')).resolves.toContain(currentHash);
    await expect(readFile(join(fixture.root, 'flake.nix'), 'utf-8')).resolves.not.toContain(fakeHash);
    await expect(readFile(fixture.nixLogPath, 'utf-8')).resolves.toBe('current\n');
    expect(result.stdout).toContain('pnpmDeps hash still valid');

    const cache = JSON.parse(
      await readFile(join(fixture.root, '.git/scream-code/pnpm-deps-hashes-v1.json'), 'utf-8'),
    ) as Record<string, { hash: string }>;
    expect(Object.values(cache)).toContainEqual(expect.objectContaining({ hash: currentHash }));
  });

  it('writes a local cache after discovery and verifies the cached hash on the next run', async () => {
    const fixture = await createFixtureRepo(currentHash);

    await runUpdateScript(fixture, { currentValid: false });
    await expect(readFile(join(fixture.root, 'flake.nix'), 'utf-8')).resolves.toContain(newHash);

    const cache = JSON.parse(
      await readFile(join(fixture.root, '.git/scream-code/pnpm-deps-hashes-v1.json'), 'utf-8'),
    ) as Record<string, { hash: string }>;
    expect(Object.values(cache)).toContainEqual(expect.objectContaining({ hash: newHash }));

    await writeFile(join(fixture.root, 'flake.nix'), flakeWithHash(currentHash));
    await writeFile(fixture.nixLogPath, '');

    const result = await runUpdateScript(fixture, { currentValid: false });

    await expect(readFile(join(fixture.root, 'flake.nix'), 'utf-8')).resolves.toContain(newHash);
    await expect(readFile(fixture.nixLogPath, 'utf-8')).resolves.toBe('current\nnew\n');
    expect(result.stdout).toContain('cache hit');
  });
});

async function createFixtureRepo(hash: string): Promise<{ binDir: string; nixLogPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scream-update-pnpm-deps-'));
  tempRoots.push(root);

  await writeFile(join(root, 'flake.nix'), flakeWithHash(hash));
  await writeFile(join(root, 'flake.lock'), '{}\n');
  await writeFile(join(root, '.npmrc'), 'engine-strict=true\n');
  await writeFile(join(root, 'package.json'), '{"name":"root"}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  await mkdir(join(root, 'apps/example'), { recursive: true });
  await writeFile(join(root, 'apps/example/package.json'), '{"name":"example"}\n');

  await execFileAsync('git', ['init'], { cwd: root });

  const binDir = join(root, 'bin');
  const nixLogPath = join(root, 'nix.log');
  await mkdir(binDir);
  await writeFile(nixLogPath, '');
  await writeFile(
    join(binDir, 'nix'),
    `#!/usr/bin/env bash
set -euo pipefail

state=unknown
if grep -Fq "$CURRENT_HASH" flake.nix; then
  state=current
elif grep -Fq "$FAKE_HASH" flake.nix; then
  state=fake
elif grep -Fq "$NEW_HASH" flake.nix; then
  state=new
fi

printf '%s\\n' "$state" >> "$NIX_LOG"

case "$state" in
  current)
    if [ "\${CURRENT_VALID:-0}" = "1" ]; then
      exit 0
    fi
    echo "current hash invalid" >&2
    exit 1
    ;;
  fake)
    echo "error: hash mismatch" >&2
    echo "       got:    $NEW_HASH" >&2
    exit 1
    ;;
  new)
    exit 0
    ;;
  *)
    echo "unexpected hash state: $state" >&2
    exit 1
    ;;
esac
`,
  );
  await chmod(join(binDir, 'nix'), 0o755);

  return { binDir, nixLogPath, root };
}

async function runUpdateScript(
  fixture: { binDir: string; nixLogPath: string; root: string },
  options: { currentValid: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('bash', [scriptPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CURRENT_HASH: currentHash,
      CURRENT_VALID: options.currentValid ? '1' : '0',
      FAKE_HASH: fakeHash,
      NEW_HASH: newHash,
      NIX_LOG: fixture.nixLogPath,
      PATH: `${fixture.binDir}:${process.env['PATH'] ?? ''}`,
    },
  });
}

function flakeWithHash(hash: string): string {
  return `{
  outputs = { self, nixpkgs }: {
    packages.x86_64-linux.scream-code-pnpm-deps = {
      hash = "${hash}";
    };
  };
}
`;
}
