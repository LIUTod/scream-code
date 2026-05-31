export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

export interface CLIOptions {
  session: string | undefined;
  continue: boolean;
  yolo: boolean;
  auto: boolean;
  plan: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  prompt: string | undefined;
  skillsDirs: string[];
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
    throw new OptionConflictError('提示不能为空。');
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError('模型不能为空。');
  }
  if (!promptMode && opts.outputFormat !== undefined) {
    throw new OptionConflictError('输出格式仅在提示模式下支持。');
  }
  if (promptMode && opts.yolo) {
    throw new OptionConflictError('--prompt 不能与 --yolo 同时使用。');
  }
  if (promptMode && opts.auto) {
    throw new OptionConflictError('--prompt 不能与 --auto 同时使用。');
  }
  if (promptMode && opts.plan) {
    throw new OptionConflictError('--prompt 不能与 --plan 同时使用。');
  }
  if (promptMode && opts.session === '') {
    throw new OptionConflictError('在提示模式下不能使用不带 ID 的 --session。');
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError('--continue 和 --session 不能同时使用。');
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError('--yolo 不能与 --auto 同时使用。');
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.yolo) {
    throw new OptionConflictError('--yolo 不能与 --continue 或 --session 同时使用。');
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.auto) {
    throw new OptionConflictError('--auto 不能与 --continue 或 --session 同时使用。');
  }
  if (!promptMode && (opts.continue || opts.session !== undefined) && opts.plan) {
    throw new OptionConflictError('--plan 不能与 --continue 或 --session 同时使用。');
  }
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
