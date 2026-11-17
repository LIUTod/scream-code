import { t } from '@scream-code/config';
export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

export interface CLIOptions {
  session: string | undefined;
  continue: boolean;
  yolo: boolean;
  auto: boolean;
  plan: boolean;
  wolfpack: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  prompt: string | undefined;
  skillsDirs: string[];
  /** `--max-time`: wall-clock limit for a prompt-mode run, in ms. */
  maxTimeMs?: number | undefined;
}

export interface ValidatedOptions {
  options: CLIOptions;
  uiMode: UIMode;
}

export class OptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionConflictError';
  }
}

export function validateOptions(opts: CLIOptions): ValidatedOptions {
  const prompt = opts.prompt;
  const promptMode = prompt !== undefined;
  if (promptMode && prompt.trim().length === 0) {
    throw new OptionConflictError(t('cli.err.prompt_empty'));
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError(t('cli.err.model_empty'));
  }
  if (!promptMode && opts.outputFormat !== undefined) {
    throw new OptionConflictError(t('cli.err.output_format_prompt_only'));
  }
  if (!promptMode && opts.maxTimeMs !== undefined) {
    throw new OptionConflictError(t('cli.err.max_time_prompt_only'));
  }
  if (promptMode && opts.yolo) {
    throw new OptionConflictError(t('cli.err.prompt_conflict', { flag: '--yolo' }));
  }
  if (promptMode && opts.auto) {
    throw new OptionConflictError(t('cli.err.prompt_conflict', { flag: '--auto' }));
  }
  if (promptMode && opts.plan) {
    throw new OptionConflictError(t('cli.err.prompt_conflict', { flag: '--plan' }));
  }
  if (promptMode && opts.wolfpack) {
    throw new OptionConflictError(t('cli.err.prompt_conflict', { flag: '--wolfpack' }));
  }
  if (promptMode && opts.session === '') {
    throw new OptionConflictError(t('cli.err.session_id_required'));
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError(t('cli.err.continue_session_conflict'));
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError(t('cli.err.yolo_auto_conflict'));
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.yolo) {
    throw new OptionConflictError(t('cli.err.resume_conflict', { flag: '--yolo' }));
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.auto) {
    throw new OptionConflictError(t('cli.err.resume_conflict', { flag: '--auto' }));
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.plan) {
    throw new OptionConflictError(t('cli.err.resume_conflict', { flag: '--plan' }));
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.wolfpack) {
    throw new OptionConflictError(t('cli.err.resume_conflict', { flag: '--wolfpack' }));
  }
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
