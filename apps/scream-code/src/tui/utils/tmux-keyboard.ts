import { spawn } from 'node:child_process';

import { t } from '@scream-code/config';

const TMUX_QUERY_TIMEOUT_MS = 2000;

export const TMUX_EXTENDED_KEYS_OFF_WARNING =
  t('tmux.extended_keys_off');

export const TMUX_EXTENDED_KEYS_FORMAT_XTERM_WARNING =
  t('tmux.extended_keys_format_xterm');

export type TmuxOptionReader = (option: string) => Promise<string | undefined>;

export async function detectTmuxKeyboardWarning(
  env: NodeJS.ProcessEnv = process.env,
  readTmuxOption: TmuxOptionReader = readTmuxOptionFromProcess,
): Promise<string | undefined> {
  if ((env['TMUX'] ?? '').length === 0) return undefined;

  const [extendedKeys, extendedKeysFormat] = await Promise.all([
    readTmuxOption('extended-keys'),
    readTmuxOption('extended-keys-format'),
  ]);

  if (extendedKeys === undefined) return undefined;

  if (extendedKeys !== 'on' && extendedKeys !== 'always') {
    return TMUX_EXTENDED_KEYS_OFF_WARNING;
  }

  if (extendedKeysFormat === 'xterm') {
    return TMUX_EXTENDED_KEYS_FORMAT_XTERM_WARNING;
  }

  return undefined;
}

function readTmuxOptionFromProcess(option: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['show', '-gv', option], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      proc.kill();
      finish(undefined);
    }, TMUX_QUERY_TIMEOUT_MS);

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    proc.on('error', () => {
      finish(undefined);
    });
    proc.on('close', (code) => {
      finish(code === 0 ? stdout.trim() : undefined);
    });
  });
}
