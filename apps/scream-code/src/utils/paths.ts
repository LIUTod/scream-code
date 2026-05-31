/**
 * CLI-owned data path helpers.
 *
 * These paths are for local app data such as logs and input history. Config
 * files are owned by Core/SDK and intentionally do not live behind this module.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  SCREAM_CODE_DATA_DIR_NAME,
  SCREAM_CODE_HOME_ENV,
  SCREAM_CODE_INPUT_HISTORY_DIR_NAME,
  SCREAM_CODE_LOG_DIR_NAME,
  SCREAM_CODE_UPDATE_DIR_NAME,
  SCREAM_CODE_UPDATE_STATE_FILE_NAME,
} from '#/constant/app';

/**
 * Return the root data directory for Scream Code.
 *
 * Priority: `SCREAM_CODE_HOME` env var > `~/.scream-code`.
 */
export function getDataDir(): string {
  const envDir = process.env[SCREAM_CODE_HOME_ENV];
  if (envDir) {
    return envDir;
  }
  return join(homedir(), SCREAM_CODE_DATA_DIR_NAME);
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
