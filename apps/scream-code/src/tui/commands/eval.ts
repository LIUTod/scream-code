import { runAllEvals, type EvalSummary } from '@scream-code/evals';
import { t } from '@scream-code/config';
import chalk from 'chalk';
import type { Component } from '@liutod-scream/pi-tui';

import { UsagePanelComponent } from '../components/messages/usage-panel';
import type { TUIState } from '../tui-state';
import type { SlashCommandHost } from './dispatch';

const EVAL_PANEL_DISMISS_MS = 60_000;

let activeEvalPanel: Component | undefined;
let activeEvalTimer: ReturnType<typeof setTimeout> | undefined;
/** Guards against overlapping runs (each run calls a real model and costs
 *  tokens; a second /eval while one is running is almost certainly a mistake). */
let evalRunning = false;

function dismissEvalPanel(state: TUIState): void {
  if (activeEvalTimer !== undefined) {
    clearTimeout(activeEvalTimer);
    activeEvalTimer = undefined;
  }
  if (activeEvalPanel !== undefined) {
    state.transcriptContainer.removeChild(activeEvalPanel);
    activeEvalPanel = undefined;
    state.ui.requestRender();
  }
}

export function clearEvalPanelState(state: TUIState): void {
  dismissEvalPanel(state);
}

/** Model selector for eval runs; falls back to the active session model. */
function resolveEvalModel(host: SlashCommandHost): string | undefined {
  return host.state.appState.model;
}

/**
 * Runs the end-to-end evals in the background (they call a real model and can
 * take minutes) and renders the per-case report when done. Returns immediately
 * so the TUI keeps responding.
 */
export function runEvalCommand(host: SlashCommandHost): void {
  if (evalRunning) {
    host.showStatus(t('dispatch.eval_running'));
    return;
  }
  const model = resolveEvalModel(host);
  if (model === undefined || model.length === 0) {
    host.showError(t('dispatch.eval_no_model'));
    return;
  }

  // Capture the session this run belongs to. If the user switches sessions
  // while the evals run (minutes), the report must not land in the new
  // session's view.
  const sessionId = host.state.appState.sessionId;

  evalRunning = true;
  host.showStatus(t('dispatch.eval_started', { model }));
  void (async () => {
    let summary: EvalSummary;
    try {
      summary = await runAllEvals({
        model,
        onProgress: ({ completed, total, passed, failed, currentName }) => {
          host.showStatus(
            t('dispatch.eval_progress', {
              completed: String(completed),
              total: String(total),
              passed: String(passed),
              failed: String(failed),
              name: currentName,
            }),
          );
        },
      });
    } catch (error) {
      evalRunning = false;
      host.showError(
        t('dispatch.eval_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    evalRunning = false;
    if (sessionId !== undefined && sessionId !== host.state.appState.sessionId) {
      // The user switched sessions during the run; drop the report instead
      // of rendering it into the wrong conversation.
      return;
    }
    try {
      renderEvalSummary(host, summary);
    } catch (error) {
      host.showError(
        t('dispatch.eval_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  })();
}

function renderEvalSummary(host: SlashCommandHost, summary: EvalSummary): void {
  const colors = host.state.theme.colors;
  const lines: string[] = [
    chalk.hex(colors.primary)(`${summary.passed} ${t('dispatch.eval_passed')} · ${summary.failed} ${t('dispatch.eval_failed_count')}`),
    '',
  ];

  for (const result of summary.results) {
    const mark = result.passed ? '✓' : '×';
    const color = result.passed ? colors.success : colors.error;
    lines.push(`${chalk.hex(color)(mark)} ${result.name}`);
    if (result.passed) continue;

    // User-facing guidance, kept general so the user checks their own side
    // (network / model / config) instead of assuming a product bug. The raw
    // failure details stay below in dimmed text for developers.
    lines.push(`  ${chalk.hex(colors.error)(suggestionFor(result))}`);

    const details: string[] = [];
    for (const rule of result.failedRules) details.push(rule);
    for (const failure of result.extraFailures) details.push(failure);
    if (result.error !== undefined) details.push(result.error);
    if (result.output.length > 0) details.push(`output: ${result.output.slice(0, 160)}`);
    for (const detail of details) {
      lines.push(`  ${chalk.hex(colors.textDim)(`· ${detail}`)}`);
    }
  }
  lines.push('');

  dismissEvalPanel(host.state);
  const panel = new UsagePanelComponent(lines, colors.primary, ' Eval ');
  host.state.transcriptContainer.addChild(panel);
  activeEvalPanel = panel;
  activeEvalTimer = setTimeout(() => {
    dismissEvalPanel(host.state);
  }, EVAL_PANEL_DISMISS_MS);
  host.state.ui.requestRender();
}

/** Picks a user-facing self-check hint based on how the case failed. */
function suggestionFor(result: EvalSummary['results'][number]): string {
  if (result.error !== undefined) {
    return t('dispatch.eval_suggest_error');
  }
  if (result.timedOut) {
    return t('dispatch.eval_suggest_timeout');
  }
  if (result.toolCheckFailed) {
    return t('dispatch.eval_suggest_tool');
  }
  return t('dispatch.eval_suggest_answer');
}
