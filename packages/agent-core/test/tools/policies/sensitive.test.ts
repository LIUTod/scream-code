import { describe, expect, it } from 'vitest';

import { isSecretBearingPath, isSensitiveFile } from '../../../src/tools/policies/sensitive';

describe('isSensitiveFile', () => {
  it('flags base .env files in any directory', () => {
    for (const path of ['.env', '/app/.env', 'project/.env']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags .env.<environment> variants', () => {
    for (const path of ['.env.local', '.env.production', '/app/.env.staging']) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('flags cloud credential file locations', () => {
    for (const path of [
      '/home/user/.aws/credentials',
      '/home/user/.gcp/credentials',
      '.aws/credentials',
      '.gcp/credentials',
      'credentials',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('matches sensitive patterns case-insensitively on posix paths', () => {
    for (const path of [
      '.ENV',
      '/app/.Env.Local',
      '/home/user/.AWS/Credentials',
      '/home/user/.GCP/CREDENTIALS',
      '/home/user/.ssh/ID_RSA',
      '/home/user/.ssh/ID_ED25519.OLD',
    ]) {
      expect(isSensitiveFile(path), path).toBe(true);
    }
  });

  it('does not flag normal source / config files or env exemplars', () => {
    // Mirrors the py parametrization exactly. `.envrc`, `environment.py`,
    // `.env_example`, `server.key.example`, `id_rsa.pub`, `credentials.json`
    // (basename is `credentials.json`, not the bare `credentials` token) must
    // all pass through.
    for (const path of [
      'app.py',
      'config.yml',
      'README.md',
      'package.json',
      'server.key.example',
      'id_rsa.pub',
      'credentials.json',
      '.envrc',
      'environment.py',
      '.env_example',
      '.env.example',
      '.ENV.EXAMPLE',
      '.env.sample',
      '.ENV.SAMPLE',
      '.env.template',
      '.ENV.TEMPLATE',
      '/app/.env.example',
      '/app/.ENV.EXAMPLE',
    ]) {
      expect(isSensitiveFile(path), path).toBe(false);
    }
  });
});

describe('isSecretBearingPath', () => {
  const home = '/home/me';
  it('flags credential files, not ordinary files outside the workspace', () => {
    for (const path of [
      '/work/app/.env',
      '/home/me/.npmrc',
      '/home/me/.netrc',
      '/home/me/.docker/config.json',
      '/home/me/.kube/config',
      '/home/me/.scream-code/config.toml',
      '/home/me/.ssh/id_ed25519',
      '/home/me/.aws/credentials',
      '/opt/svc/api-token.json',
    ]) {
      expect(isSecretBearingPath(path, home), path).toBe(true);
    }
    for (const path of [
      '/home/me/Downloads/oss/README.md',
      '/home/me/.ssh/id_ed25519.pub',
      '/home/me/.ssh/known_hosts',
      '/home/me/.zshrc',
      '/tmp/notes.txt',
      '/other/.npmrc-guide/readme.md',
    ]) {
      expect(isSecretBearingPath(path, home), path).toBe(false);
    }
  });
});
