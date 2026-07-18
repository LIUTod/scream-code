/**
 * /btw — Fast side question without interrupting the main conversation.
 *
 * Makes a standalone LLM call with recent conversation context injected
 * into the system prompt. The answer is shown in an overlay; dismissing it
 * restores the editor. The question and answer are never recorded in the
 * main conversation history.
 */

import {
  Container,
  matchesKey,
  Key,
  Markdown,
  type Focusable,
  type MarkdownTheme,
} from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import { t } from '@scream-code/config';
import type { ColorPalette } from '../theme/colors';
import type { SlashCommandHost } from './dispatch';
import { type Disposable } from '../utils/component-capabilities';

// ─── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ─── Overlay ────────────────────────────────────────────────────────────────

type BtwStatus = 'loading' | 'done' | 'error';

class BtwOverlayComponent extends Container implements Focusable, Disposable {
  focused = false;
  private disposed = false;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  private status: BtwStatus = 'loading';
  private markdown: Markdown | undefined;

  constructor(
    private readonly question: string,
    private answer: string,
    private readonly colors: ColorPalette,
    private readonly markdownTheme: MarkdownTheme,
    private readonly requestRender: () => void,
    private readonly onDismiss: () => void,
  ) {
    super();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.cleanup();
      this.onDismiss();
      return;
    }
    if (
      this.status !== 'loading' &&
      (matchesKey(data, Key.enter) || matchesKey(data, Key.space))
    ) {
      this.cleanup();
      this.onDismiss();
    }
  }

  setAnswer(text: string): void {
    if (this.disposed) return;
    this.answer = text;
    this.status = 'done';
    this.markdown = new Markdown(text.trim(), 0, 0, this.markdownTheme);
    this.stopSpinner();
    this.requestRender();
  }

  setError(error: string): void {
    if (this.disposed) return;
    this.answer = error;
    this.status = 'error';
    this.stopSpinner();
    this.requestRender();
  }

  startSpinner(): void {
    this.spinnerFrame = 0;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval !== undefined) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = undefined;
    }
  }

  private cleanup(): void {
    this.stopSpinner();
  }

  dispose(): void {
    this.disposed = true;
    this.stopSpinner();
  }

  override render(width: number): string[] {
    const c = this.colors;
    const lines: string[] = [];

    // ── Title ──
    const truncated = this.question.length > width - 10
      ? this.question.slice(0, width - 13) + '…'
      : this.question;
    lines.push(
      chalk.hex(c.primary)('/btw') +
        chalk.hex(c.textMuted)(' — ') +
        chalk.hex(c.text)(truncated),
    );

    lines.push('');

    // ── Content ──
    if (this.status === 'loading') {
      const spinner = SPINNER_FRAMES[this.spinnerFrame];
      lines.push(chalk.hex(c.textMuted)(`${spinner} Answering…`));
    } else if (this.status === 'done' && this.markdown !== undefined) {
      const contentWidth = Math.max(20, width - 2);
      const mdLines = this.markdown.render(contentWidth);
      for (const line of mdLines) {
        lines.push(`  ${line}`);
      }
    } else if (this.status === 'error') {
      lines.push(chalk.hex(c.error)(this.answer || 'Something went wrong.'));
    }

    lines.push('');

    // ── Footer ──
    lines.push(
      chalk.hex(c.primary)('Esc') + chalk.hex(c.textMuted)(' dismiss'),
    );

    return lines;
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleBtwCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const question = args.trim();
  if (question.length === 0) {
    host.showNotice(
      t('btw.usage'),
      t('btw.desc') + '\n\n' + t('btw.example1') + '\n' + t('btw.example2'),
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(t('btw.no_session'));
    return;
  }

  const overlay = new BtwOverlayComponent(
    question,
    '',
    host.state.theme.colors,
    host.state.theme.markdownTheme,
    () => {
      host.state.ui.requestRender();
    },
    () => {
      host.restoreEditor();
    },
  );

  overlay.startSpinner();
  host.mountEditorReplacement(overlay);

  try {
    const answer = await session.sideQuestion(question);
    overlay.setAnswer(answer);
  } catch (error) {
    overlay.setError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
