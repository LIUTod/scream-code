/**
 * Sensitive-file detection.
 *
 * The pattern list is intentionally small to avoid false positives; files
 * matching any of these patterns are blocked from Read/Write/Edit so
 * credentials cannot be exfiltrated through a compromised prompt. Exemptions
 * like `.env.example` are explicitly allowed.
 */

import { basename } from 'pathe';

const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
]);

const SENSITIVE_PATH_SUFFIXES = [
  ['.aws', 'credentials'],
  ['.gcp', 'credentials'],
];

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set<string>(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
export const SENSITIVE_DOT_VARIANT_SUFFIXES = [
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
] as const;
const SENSITIVE_DOT_VARIANT_SUFFIX_SET = new Set<string>(SENSITIVE_DOT_VARIANT_SUFFIXES);

function comparable(path: string): string {
  return path.toLowerCase();
}

export function isSensitiveFile(path: string): boolean {
  const name = basename(path);
  const comparableName = comparable(name);
  const comparablePath = comparable(path);

  if (ENV_EXEMPTIONS.has(comparableName)) return false;
  if (PUBLIC_KEY_BASENAMES.has(comparableName)) return false;
  if (SENSITIVE_BASENAMES.has(comparableName)) return true;
  if (comparableName.startsWith(ENV_PREFIX)) return true;

  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (comparableName === prefix) return true;
    // Catch rename-shielded variants without flagging unrelated filenames
    // like `id_rsafoo` or ordinary JSON files like `credentials.json`.
    if (comparableName.length > prefix.length && comparableName.startsWith(prefix)) {
      const suffix = comparableName.slice(prefix.length);
      const next = suffix[0];
      if (next === '-' || next === '_') return true;
      if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIX_SET.has(suffix)) return true;
    }
  }

  for (const suffixParts of SENSITIVE_PATH_SUFFIXES) {
    const suffix = suffixParts.join('/');
    const comparableSuffix = comparable(suffix);
    if (
      comparablePath.endsWith(`/${comparableSuffix}`) ||
      comparablePath.includes(`/${comparableSuffix}/`)
    ) {
      return true;
    }
  }

  return false;
}

/** Home-relative files that hold tokens or passwords in plain text. */
const SECRET_HOME_FILES = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.docker/config.json',
  '.kube/config',
  '.config/gh/hosts.yml',
  '.scream-code/config.toml',
]);
/** Home-relative folders whose files are secrets (public keys and host lists aside). */
const SECRET_HOME_DIRS = new Set(['.ssh', '.aws', '.gnupg']);
const SECRET_DIR_EXEMPT = new Set(['known_hosts', 'known_hosts.old', 'config']);
/** A config-ish file whose name says it holds a credential. */
const SECRET_NAME = /(?:token|credential|secret|auth)[\w.-]*\.(?:json|toml|ya?ml|ini|txt)$/i;

/**
 * Files whose content is a credential: what the yolo hard floor guards before
 * data may leave the machine. Broader than `isSensitiveFile` (which blocks
 * access outright), narrower than "any file outside the workspace" — reading
 * someone's open-source repo or the docs next door is not a secret.
 */
export function isSecretBearingPath(path: string, home: string): boolean {
  if (isSensitiveFile(path)) return true;
  const normalized = path.replaceAll('\\', '/');
  const name = basename(normalized).toLowerCase();
  if (SECRET_NAME.test(name)) return true;
  const homePrefix = `${home.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  if (home === '' || !normalized.startsWith(homePrefix)) return false;
  const rel = normalized.slice(homePrefix.length);
  if (SECRET_HOME_FILES.has(rel)) return true;
  const top = rel.split('/')[0] ?? '';
  if (!SECRET_HOME_DIRS.has(top) || rel === top) return false;
  return !name.endsWith('.pub') && !SECRET_DIR_EXEMPT.has(name);
}
