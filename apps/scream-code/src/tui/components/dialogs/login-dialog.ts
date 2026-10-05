import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
} from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { hasHttpUrl, toTerminalHyperlink } from '#/utils/terminal-hyperlink';

export type LoginDialogResult = { readonly kind: 'done' } | { readonly kind: 'cancel' };

export interface LoginDialogLink {
  readonly label?: string | undefined;
  readonly url: string;
}

/**
 * One retained flow-step line. `wrap` marks a line whose text is a URL: it is
 * wrapped over as many rows as it needs (each row carries the same link
 * target) instead of being truncated, because the trailing query parameters of
 * an authorization URL (state, code_challenge_method) are what make it work.
 * Every other line keeps the single-line truncation.
 */
interface ContentLine {
  readonly text: string;
  readonly wrap: boolean;
}

/**
 * Login flow dialog — replaces the editor while an OAuth sign-in runs.
 *
 * Follows the api-key dialog's line-drawing style; flow steps append to a
 * content block (auth URL, device code, prompts) instead of rebuilding
 * component trees, so the panel reads as one continuous card.
 */
export class LoginDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly onDone: (result: LoginDialogResult) => void;
  private readonly onRender: () => void;
  private readonly colors: ColorPalette;
  private readonly providerName: string;
  private readonly openUrl: (url: string) => void;
  private readonly abortController = new AbortController();

  /** Completed step output (kept on screen as the flow progresses). */
  private readonly contentLines: ContentLine[] = [];
  private progressLine: string | undefined;
  private promptLine: string | undefined;
  private promptPlaceholder: string | undefined;
  private promptAllowEmpty = false;
  private promptAbortCleanup: (() => void) | undefined;
  private inputResolver: ((value: string) => void) | undefined;
  private inputRejecter: ((error: Error) => void) | undefined;
  private finished = false;

  constructor(
    providerName: string,
    colors: ColorPalette,
    openUrl: (url: string) => void,
    onRender: () => void,
    onDone: (result: LoginDialogResult) => void,
  ) {
    super();
    this.providerName = providerName;
    this.colors = colors;
    this.openUrl = openUrl;
    this.onRender = onRender;
    this.onDone = onDone;
    this.input.onSubmit = (value) => {
      this.resolveInput(value);
    };
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Retain one flow step line; `wrap` only for lines whose whole text is a URL. */
  private pushContent(text: string, wrap = false): void {
    this.contentLines.push({ text, wrap });
  }

  // ── Flow steps ─────────────────────────────────────────────────────────────

  /** Browser authorization step: show (and open) the authorization URL. */
  showAuth(url: string, instructions?: string): void {
    // The flow can be cancelled while a step is being bound; a late step must
    // neither append output nor launch a browser for an abandoned sign-in.
    if (this.finished) return;
    this.pushContent(this.hyperlink(url, this.colors.primary), true);
    const clickHint =
      process.platform === 'darwin' ? t('login.click_hint_mac') : t('login.click_hint');
    this.pushContent(chalk.hex(this.colors.textDim)(clickHint));
    if (instructions !== undefined && instructions.length > 0) {
      this.pushContent('');
      this.pushContent(chalk.hex(this.colors.warning)(instructions));
    }
    this.openUrl(url);
    this.onRender();
  }

  /** Device-code step: show the verification URL and the user code. */
  showDeviceCode(info: { userCode: string; verificationUri: string }): void {
    // Same late-binding guard as the browser step: nothing is drawn once the
    // flow has already finished.
    if (this.finished) return;
    this.pushContent(this.hyperlink(info.verificationUri, this.colors.primary), true);
    this.pushContent('');
    this.pushContent(
      chalk.hex(this.colors.warning)(t('login.device_code', { code: info.userCode })),
    );
    this.onRender();
  }

  /** Informational step with optional links. */
  showInfo(message: string, links: readonly LoginDialogLink[] = []): void {
    // Some flows put a URL in the message itself (a listening address or the
    // redirect URL to paste); the tail of that URL is what tells the user where
    // to go, so a message carrying one wraps like the dedicated URL lines.
    // Prose without a URL keeps the single-line truncation.
    this.pushContent(chalk.hex(this.colors.textStrong)(message), hasHttpUrl(message));
    for (const link of links) {
      const text = link.label !== undefined ? `${link.label}: ${link.url}` : link.url;
      this.pushContent(this.hyperlinkUrl(text, link.url), true);
    }
    this.onRender();
  }

  /** Progress line (replaces the previous one). */
  showProgress(message: string): void {
    this.progressLine = chalk.hex(this.colors.textDim)(message);
    this.onRender();
  }

  /**
   * Ask for pasted input (manual code / redirect URL).
   *
   * `allowEmpty` accepts a blank submission as a valid answer (a flow may
   * document a blank line as "use the default"); without it an empty submit is
   * ignored so a stray Enter cannot answer a prompt by accident.
   *
   * `signal` cancels just this prompt — the flow aborts it when another input
   * path wins (e.g. the browser callback arrived first), which drops the stale
   * input row instead of leaving a focused line that swallows typed input.
   */
  promptInput(
    message: string,
    placeholder?: string,
    options: { allowEmpty?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    this.clearPrompt();
    this.promptLine = message;
    this.promptPlaceholder = placeholder;
    this.promptAllowEmpty = options.allowEmpty === true;
    this.input.setValue('');
    this.onRender();
    return new Promise((resolve, reject) => {
      this.inputResolver = resolve;
      this.inputRejecter = reject;
      const signal = options.signal;
      if (signal === undefined) return;
      const onAbort = (): void => {
        this.clearPrompt();
        reject(new Error('Login cancelled'));
        this.onRender();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.promptAbortCleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
    });
  }

  /** Drop a pending prompt: input row, resolvers and per-prompt abort listener. */
  private clearPrompt(): void {
    this.promptAbortCleanup?.();
    this.promptAbortCleanup = undefined;
    this.promptLine = undefined;
    this.promptPlaceholder = undefined;
    this.promptAllowEmpty = false;
    this.inputResolver = undefined;
    this.inputRejecter = undefined;
  }

  /** Flow finished successfully; the caller restores the editor afterwards. */
  complete(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearPrompt();
    this.onDone({ kind: 'done' });
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.abortController.abort();
    const rejecter = this.inputRejecter;
    this.clearPrompt();
    rejecter?.(new Error('Login cancelled'));
    this.onDone({ kind: 'cancel' });
  }

  // ── Input wiring ───────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.finished) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }
    if (this.inputResolver !== undefined) {
      this.input.handleInput(data);
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  private resolveInput(value: string): void {
    const resolver = this.inputResolver;
    if (resolver === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 && !this.promptAllowEmpty) return;
    this.clearPrompt();
    // Keep the submitted value visible in the transcript portion of the card.
    this.pushContent(chalk.hex(this.colors.textDim)(`> ${trimmed}`));
    resolver(trimmed);
    this.onRender();
  }

  private hyperlink(url: string, color: string): string {
    return this.hyperlinkUrl(url, url, color);
  }

  private hyperlinkUrl(text: string, url: string, color?: string): string {
    return chalk.hex(color ?? this.colors.textDim)(toTerminalHyperlink(text, url));
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.finished && this.inputResolver !== undefined;

    const safeWidth = Math.max(28, width);
    const innerWidth = Math.max(10, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => chalk.hex(this.colors.primary)(s);
    const title = t('login.title', { name: this.providerName });
    const titleStyled = chalk.bold.hex(this.colors.textStrong)(title);
    const footerStyled = chalk.hex(this.colors.textDim)(t('login.footer'));

    const contentLines: string[] = [truncateToWidth(titleStyled, innerWidth, '…'), ''];

    for (const line of this.contentLines) {
      if (line.wrap) {
        // Wrapped, never truncated: the OSC 8 escapes are zero-width and
        // wrapTextWithAnsi re-opens the link on every continuation row, so the
        // whole URL stays readable, copyable and clickable.
        contentLines.push(...wrapTextWithAnsi(line.text, innerWidth));
        continue;
      }
      contentLines.push(truncateToWidth(line.text, innerWidth, '…'));
    }
    if (this.progressLine !== undefined) {
      contentLines.push(truncateToWidth(this.progressLine, innerWidth, '…'));
    }
    if (this.promptLine !== undefined) {
      contentLines.push('');
      contentLines.push(truncateToWidth(chalk.hex(this.colors.textStrong)(this.promptLine), innerWidth, '…'));
      if (this.promptPlaceholder !== undefined && this.promptPlaceholder.length > 0) {
        contentLines.push(
          truncateToWidth(chalk.hex(this.colors.textDim)(t('login.prompt_example', { value: this.promptPlaceholder })), innerWidth, '…'),
        );
      }
    }
    contentLines.push('');
    if (this.inputResolver !== undefined) {
      contentLines.push(this.input.render(innerWidth)[0] ?? '> ');
    }
    contentLines.push('');
    contentLines.push(truncateToWidth(footerStyled, innerWidth, '…'));

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];
    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }
    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');
    return lines;
  }
}
