import { SCREAM_ERROR_INFO, isScreamError } from '@scream-code/scream-code-sdk';
import { t } from '@scream-code/config';
import { chalkStderr } from 'chalk';

import { STARTUP_ERROR_COLOR } from '#/constant/startup-error';

export interface StartupErrorFormatOptions {
  readonly errorStyle?: (text: string) => string;
  readonly operation?: string;
}

function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatStartupError(
  error: unknown,
  options: StartupErrorFormatOptions = {},
): string {
  const errorStyle = options.errorStyle ?? chalkStderr.hex(STARTUP_ERROR_COLOR);

  if (!isScreamError(error)) {
    const operation = options.operation ?? 'start shell';
    return `${errorStyle(t('cli.err.operation_failed', { operation, message: formatUnknownErrorMessage(error) }))}\n`;
  }

  const info = SCREAM_ERROR_INFO[error.code];
  const lines = [
    errorStyle(t('cli.err.title', { title: info.title })),
    '',
    errorStyle(t('cli.err.message_label')),
    errorStyle(error.message),
  ];

  return `${lines.join('\n')}\n`;
}
