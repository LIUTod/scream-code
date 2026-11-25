/**
 * `scream host check`: can the background reach the model, with the
 * environment it actually runs in?
 *
 * A terminal and the resident service do not share an environment: a service
 * starts with almost nothing (no shell profile), so a key exported only in
 * `~/.zshrc`, a company CA in `NODE_EXTRA_CA_CERTS` or a proxy variable is
 * there in the terminal and missing in the background. Everything then works
 * while you watch and fails once you leave — the hardest failure to find.
 *
 * The check opens a session the way the host does (same config, same
 * credentials, same model) but without MCP servers or plugin hooks, sends one
 * tiny request (`generateText`, no tools, no history: a few dozen tokens), and
 * deletes the session again. Run through the service's launcher it records
 * its result in `<home>/host/check.json`, stamped with the launcher it ran
 * under, so the terminal knows whether the service can be trusted to start
 * the background (see `startBackground` in `host/service.ts`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { t } from '@scream-code/config';
import { ScreamHarness, resolveScreamHome, toScreamErrorPayload } from '@scream-code/scream-code-sdk';

import { createScreamCodeHostIdentity, getVersion } from '#/cli/version';
import { getDataDir } from '#/utils/paths';

/** Session ids of checks: kept out of every list, deleted when the check ends. */
export const HOST_CHECK_SESSION_PREFIX = 'host-check-';
const CHECK_TIMEOUT_MS = 90_000;

export type HostCheckProblem =
  /** No default model is configured. */
  | 'no_model'
  /** The provider has no key in Scream's own config or credentials (or in this environment). */
  | 'no_key'
  /** The provider refused the key. */
  | 'auth'
  /** Network, timeout, overload: the provider could not be reached. */
  | 'unreachable'
  /** Anything else: the message says what. */
  | 'failed';

export interface HostCheckResult {
  readonly ok: boolean;
  readonly at: number;
  readonly version: string;
  readonly model?: string | undefined;
  readonly problem?: HostCheckProblem | undefined;
  /** The provider's or the core's own words, for the log and the details line. */
  readonly detail?: string | undefined;
  /** sha256 of the launcher the check ran under (service checks only). */
  readonly launcher?: string | undefined;
}

export function hostCheckFile(home: string = getDataDir()): string {
  return join(home, 'host', 'check.json');
}

export function launcherFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** What went wrong, from the error a model request threw. */
export function classifyCheckError(error: unknown): { problem: HostCheckProblem; detail: string } {
  const payload = toScreamErrorPayload(error);
  const detail = payload.message.replaceAll(/\s+/g, ' ').trim().slice(0, 300);
  if (/apiKey is required|api[_ ]?key.*(missing|not set|required)/i.test(payload.message)) {
    return { problem: 'no_key', detail };
  }
  if (payload.code === 'provider.auth_error') return { problem: 'auth', detail };
  if (
    payload.code === 'provider.timeout' ||
    payload.code === 'provider.connection_error' ||
    payload.code === 'provider.rate_limit'
  ) {
    return { problem: 'unreachable', detail };
  }
  return { problem: 'failed', detail };
}

/** Run the check in this process's environment. Never throws. */
export async function runHostCheck(options: { readonly timeoutMs?: number } = {}): Promise<HostCheckResult> {
  const at = Date.now();
  const version = getVersion();
  const harness = new ScreamHarness({
    homeDir: resolveScreamHome(),
    identity: createScreamCodeHostIdentity(),
    uiMode: 'print',
  });
  let sessionId: string | undefined;
  try {
    const config = await harness.getConfig();
    const model = config.defaultModel;
    if (model === undefined || model === '') return { ok: false, at, version, problem: 'no_model' };
    const session = await harness.createSession({
      id: `${HOST_CHECK_SESSION_PREFIX}${randomBytes(4).toString('hex')}`,
      workDir: getDataDir(),
      exactWorkDir: true,
      permission: 'ask',
      scheduledTasks: false,
      extensions: false,
      // `source: 'job'` keeps it out of `/sessions` and `scream -C` for the
      // seconds it exists.
      metadata: { source: 'job', title: 'host check' },
    });
    sessionId = session.id;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no answer within ${String(Math.round((options.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000))}s`));
      }, options.timeoutMs ?? CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([session.generateText('Reply with the single word OK.', 'OK?'), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { ok: true, at, version, model };
  } catch (error) {
    const { problem, detail } = classifyCheckError(error);
    return { ok: false, at, version, problem, detail };
  } finally {
    if (sessionId !== undefined) {
      await harness.closeSession(sessionId).catch(() => {});
      await harness.deleteSession(sessionId).catch(() => {});
    }
    await harness.close().catch(() => {});
  }
}

export function writeHostCheck(result: HostCheckResult, home: string = getDataDir()): void {
  const file = hostCheckFile(home);
  mkdirSync(join(home, 'host'), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}

export function readHostCheck(home: string = getDataDir()): HostCheckResult | undefined {
  try {
    const raw = JSON.parse(readFileSync(hostCheckFile(home), 'utf8')) as Partial<HostCheckResult>;
    if (typeof raw.ok !== 'boolean' || typeof raw.at !== 'number' || typeof raw.version !== 'string') return undefined;
    return raw as HostCheckResult;
  } catch {
    return undefined;
  }
}

/** One line for a person: what the check found and, when it failed, what to do. */
export function describeHostCheck(result: HostCheckResult): string {
  if (result.ok) return t('host.check.ok', { model: result.model ?? '' });
  const problem = result.problem ?? 'failed';
  return t(`host.check.${problem}`, { detail: result.detail ?? '' });
}
