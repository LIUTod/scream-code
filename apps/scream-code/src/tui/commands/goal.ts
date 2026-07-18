import { t } from '@scream-code/config';
import type { Component } from '@liutod-scream/pi-tui';

import type { SlashCommandHost } from './dispatch';
import { GoalStatusMessageComponent } from '../components/messages/goal-panel';
import { isBusy } from '../utils/app-state';
import { detectGoalConflict } from '../utils/goal-loop-conflict';

const GOAL_STATUS_DISMISS_MS = 10_000;

let activeGoalPanel: Component | undefined;
let activeGoalTimer: ReturnType<typeof setTimeout> | undefined;

// ── Parsing ─────────────────────────────────────────────────────────────

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'off']);

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'off' }
  | { readonly kind: 'create'; readonly objective: string; readonly replace: boolean }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

/**
 * Parse the `/goal` command.
 *
 * Reserved subcommands (`pause`/`resume`/`status`/`replace`) are honored
 * as the first token.  Use `/goal -- <objective>` to start a goal whose
 * text begins with a reserved word.  Use `/goaloff` to cancel.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'off' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  if (tokens[index] === '--') {
    index += 1;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message: t('goal.need_desc'),
    };
  }
  return { kind: 'create', objective, replace };
}

// ── Command handler ─────────────────────────────────────────────────────

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      if (parsed.severity === 'hint') host.showStatus(parsed.message);
      else host.showError(parsed.message);
      return;
    case 'status':
      await showGoalStatus(host);
      return;
    case 'pause':
      await pauseGoal(host);
      return;
    case 'resume':
      await resumeGoal(host);
      return;
    case 'off':
      await handleGoalOffCommand(host);
      return;
    case 'create':
      await createGoal(host, parsed);
      return;
  }
}

// ── Subcommand implementations ──────────────────────────────────────────

async function createGoal(host: SlashCommandHost, parsed: ParsedGoalCommand & { kind: 'create' }): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(t('error.no_session'));
    return;
  }

  if (detectGoalConflict(host.state.appState, 'enable_goal') === 'goal_active') {
    host.showNotice(
      t('goal.storm_breaker'),
      t('goal.conflict_loop'),
    );
    return;
  }

  // Launch configuration wizard
  await showGoalConfigWizard(host, session, parsed.objective, parsed.replace);
}

// ── Goal Configuration Wizard ──────────────────────────────────────────

async function showGoalConfigWizard(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  objective: string,
  replace: boolean,
): Promise<void> {
  const { TextInputDialogComponent } = await import('../components/dialogs/text-input-dialog');

  // Step 1: Turn limit (0 = unlimited)
  const turnInput = await promptNumber(host, TextInputDialogComponent, {
    title: t('goal.wizard_title', { objective }),
    subtitle: t('goal.budget_turns_hint'),
    placeholder: '10',
  });
  if (turnInput === undefined) return;

  // Step 2: Token limit (0 = unlimited)
  const tokenInput = await promptNumber(host, TextInputDialogComponent, {
    title: t('goal.wizard_title', { objective }),
    subtitle: t('goal.budget_tokens_hint'),
    placeholder: '200000',
  });
  if (tokenInput === undefined) return;

  // Step 3: Time limit in minutes (0 = unlimited)
  const timeInput = await promptNumber(host, TextInputDialogComponent, {
    title: t('goal.wizard_title', { objective }),
    subtitle: t('goal.budget_time_hint'),
    placeholder: '30',
  });
  if (timeInput === undefined) return;

  // Create goal with configured options
  try {
    await session.createGoal(objective, { replace });

    // Set budgets (skip if 0 = unlimited)
    const budgets: Array<{ value: number; unit: 'turns' | 'tokens' | 'minutes' }> = [];
    if (turnInput > 0) budgets.push({ value: turnInput, unit: 'turns' });
    if (tokenInput > 0) budgets.push({ value: tokenInput, unit: 'tokens' });
    if (timeInput > 0) budgets.push({ value: timeInput, unit: 'minutes' });
    for (const b of budgets) {
      await session.setGoalBudget(b.value, b.unit);
    }

    host.showStatus(t('goal.set', { objective }));

    if (!isBusy(host.state.appState)) {
      host.sendQueuedMessage(session, { text: objective, agentId: undefined });
    } else {
      host.state.queuedMessages.push({ text: objective, agentId: undefined });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showError(t('goal.create_failed', { msg: message }));
  }
}

/** Prompt user for a non-negative integer. Returns undefined on cancel. */
function promptNumber(
  host: SlashCommandHost,
  TextInputDialogComponent: typeof import('../components/dialogs/text-input-dialog').TextInputDialogComponent,
  opts: { title: string; subtitle: string; placeholder: string },
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    const dialog = new TextInputDialogComponent(
      (result) => {
        host.restoreEditor();
        if (result.kind !== 'ok') {
          resolve(undefined);
          return;
        }
        const parsed = parseInt(result.value.trim(), 10);
        resolve(Number.isNaN(parsed) || parsed < 0 ? 0 : parsed);
      },
      {
        title: opts.title,
        subtitle: opts.subtitle,
        placeholder: opts.placeholder,
        allowEmpty: true,
        colors: host.state.theme.colors,
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

async function pauseGoal(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(t('error.no_session'));
    return;
  }

  try {
    const result = await session.getGoal();
    if (result.goal === null) {
      host.showStatus(t('goal.no_active'));
      return;
    }

    await session.updateGoalStatus('paused');
    host.showStatus(t('goal.paused'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showError(t('goal.pause_failed', { msg: message }));
  }
}

async function resumeGoal(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(t('error.no_session'));
    return;
  }

  try {
    const result = await session.getGoal();
    if (result.goal === null) {
      host.showStatus(t('goal.no_resumable'));
      return;
    }

    await session.updateGoalStatus('active');
    host.showStatus(t('goal.resumed'));

    // Resume execution
    if (!isBusy(host.state.appState)) {
      host.sendQueuedMessage(session, { text: t('goal.resume_hint'), agentId: undefined });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showError(t('goal.resume_failed', { msg: message }));
  }
}

export async function handleGoalOffCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(t('error.no_session'));
    return;
  }

  try {
    const result = await session.getGoal();
    if (result.goal === null) {
      host.showStatus(t('goal.no_active'));
      return;
    }

    await session.cancelGoal();
    host.showStatus(t('goal.cancelled'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showError(t('goal.cancel_failed', { msg: message }));
  }
}

async function showGoalStatus(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showStatus(t('error.no_session'));
    return;
  }

  try {
    const result = await session.getGoal();
    dismissGoalPanel(host);

    const panel = new GoalStatusMessageComponent(result.goal, host.state.theme.colors);
    host.state.transcriptContainer.addChild(panel);
    activeGoalPanel = panel;
    activeGoalTimer = setTimeout(() =>{  dismissGoalPanel(host); }, GOAL_STATUS_DISMISS_MS);
    host.state.ui.requestRender();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showError(t('goal.status_failed', { msg: message }));
  }
}

function dismissGoalPanel(host: SlashCommandHost): void {
  if (activeGoalTimer !== undefined) {
    clearTimeout(activeGoalTimer);
    activeGoalTimer = undefined;
  }
  if (activeGoalPanel !== undefined) {
    host.state.transcriptContainer.removeChild(activeGoalPanel);
    activeGoalPanel = undefined;
    host.state.ui.requestRender();
  }
}

/** Clear goal panel state on session switch to prevent stale timer/panel leaks. */
export function clearGoalState(): void {
  if (activeGoalTimer !== undefined) {
    clearTimeout(activeGoalTimer);
    activeGoalTimer = undefined;
  }
  activeGoalPanel = undefined;
}
