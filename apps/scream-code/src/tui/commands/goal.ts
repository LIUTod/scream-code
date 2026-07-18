import { t } from '@scream-code/config';
import type { Component } from '@liutod-scream/pi-tui';

import type { SlashCommandHost } from './dispatch';
import { GoalStatusMessageComponent } from '../components/messages/goal-panel';
import { isBusy } from '../utils/app-state';
import { detectGoalLoopConflict } from '../utils/goal-loop-conflict';

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

  // Storm Breaker: /goal and /loop are semantically incompatible. loop resets
  // context each round, which would destroy goal's working notes.
  if (detectGoalLoopConflict(host.state.appState, 'enable_goal') === 'loop_active') {
    host.showNotice(
      t('goal.storm_breaker'),
      t('goal.conflict_loop'),
    );
    return;
  }

  try {
    await session.createGoal(parsed.objective, { replace: parsed.replace });
    host.showStatus(t('goal.set', { objective: parsed.objective }));

    // Auto-start: send the objective as user input to begin execution
    if (!isBusy(host.state.appState)) {
      host.sendQueuedMessage(session, { text: parsed.objective, agentId: undefined });
    } else {
      host.state.queuedMessages.push({ text: parsed.objective, agentId: undefined });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.showError(t('goal.create_failed', { msg: message }));
  }
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
