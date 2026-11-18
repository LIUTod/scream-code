/**
 * CLI-owned data path helpers.
 *
 * These paths are for local app data such as logs and input history. Config
 * files are owned by Core/SDK and intentionally do not live behind this module.
 */

import { createHash } from 'node:crypto';
import { join, normalize } from 'node:path';

import { resolveScreamHome } from '@scream-code/scream-code-sdk';

import {
  SCREAM_CODE_INPUT_HISTORY_DIR_NAME,
  SCREAM_CODE_LOG_DIR_NAME,
  SCREAM_CODE_UPDATE_DIR_NAME,
  SCREAM_CODE_UPDATE_STATE_FILE_NAME,
} from '#/constant/app';

/**
 * Return the root data directory for Scream Code: the same Scream home the
 * engine uses (`SCREAM_CODE_HOME`, else `~/.scream-code`), resolved by one
 * function so the app and the engine can never disagree about a blank,
 * quoted, `~`-prefixed or relative value. Normalized to the platform's own
 * separators, so paths shown to Windows users do not mix `/` and `\`.
 */
export function getDataDir(): string {
  return normalize(resolveScreamHome());
}

/**
 * Return the diagnostic log directory: `<dataDir>/logs/`.
 */
export function getLogDir(): string {
  return join(getDataDir(), SCREAM_CODE_LOG_DIR_NAME);
}

/**
 * Return the update cache file: `<dataDir>/updates/latest.json`.
 */
export function getUpdateStateFile(): string {
  return join(getDataDir(), SCREAM_CODE_UPDATE_DIR_NAME, SCREAM_CODE_UPDATE_STATE_FILE_NAME);
}

/**
 * Return the user input history file for a given working directory.
 * Layout: `<share_dir>/user-history/<md5(cwd)>.jsonl`.
 */
export function getInputHistoryFile(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), SCREAM_CODE_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
