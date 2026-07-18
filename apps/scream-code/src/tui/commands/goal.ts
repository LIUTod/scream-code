import { t } from '@scream-code/config';
import type { Component } from '@liutod-scream/pi-tui';

import type { SlashCommandHost } from './dispatch';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
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

type BudgetChoice = { value: number; unit: 'turns' | 'tokens' | 'milliseconds'; label: string };
type JudgeChoice = 'ai' | 'shell' | 'none';

async function showGoalConfigWizard(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  objective: string,
  replace: boolean,
): Promise<void> {
  // Step 1: Budget type
  const budgetType = await pickBudgetType(host, objective);
  if (budgetType === undefined) return; // cancelled

  // Step 2: Budget value (skip if 'none')
  let budget: BudgetChoice | undefined;
  if (budgetType !== 'none') {
    budget = await pickBudgetValue(host, objective, budgetType);
    if (budget === undefined) return;
  }

  // Step 3: Judge type
  const judgeType = await pickJudgeType(host, objective);
  if (judgeType === undefined) return;

  // Step 4: Shell command (if judge is shell)
  let completionCriterion: string | undefined;
  if (judgeType === 'shell') {
    completionCriterion = await pickShellCommand(host, objective);
    if (completionCriterion === undefined) return;
  }

  // Create goal with configured options
  try {
    await session.createGoal(objective, { replace, completionCriterion });
    if (budget !== undefined) {
      await session.setGoalBudget(budget.value, budget.unit);
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

function pickBudgetType(host: SlashCommandHost, objective: string): Promise<'turns' | 'tokens' | 'time' | 'none' | undefined> {
  return pickChoice(host, {
    title: t('goal.wizard_title', { objective }),
    options: [
      { value: 'turns', label: t('goal.budget_turns'), description: t('goal.budget_turns_desc') },
      { value: 'tokens', label: t('goal.budget_tokens'), description: t('goal.budget_tokens_desc') },
      { value: 'time', label: t('goal.budget_time'), description: t('goal.budget_time_desc') },
      { value: 'none', label: t('goal.budget_none'), description: t('goal.budget_none_desc') },
    ],
  });
}

function pickBudgetValue(host: SlashCommandHost, objective: string, type: 'turns' | 'tokens' | 'time'): Promise<BudgetChoice | undefined> {
  const options: ChoiceOption[] = type === 'turns'
    ? [
        { value: '5', label: '5' },
        { value: '10', label: '10' },
        { value: '20', label: '20' },
        { value: '50', label: '50' },
      ]
    : type === 'tokens'
      ? [
          { value: '50000', label: '50K' },
          { value: '100000', label: '100K' },
          { value: '200000', label: '200K' },
          { value: '500000', label: '500K' },
        ]
      : [
          { value: '300000', label: '5 min' },
          { value: '900000', label: '15 min' },
          { value: '1800000', label: '30 min' },
          { value: '3600000', label: '1 hour' },
        ];

  return new Promise<BudgetChoice | undefined>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('goal.wizard_title', { objective }),
      options,
      colors: host.state.theme.colors,
      onSelect: (val: string) => {
        host.restoreEditor();
        const num = Number(val);
        resolve({ value: num, unit: type === 'time' ? 'milliseconds' : type, label: options.find(o => o.value === val)?.label ?? val });
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

function pickJudgeType(host: SlashCommandHost, objective: string): Promise<JudgeChoice | undefined> {
  return pickChoice(host, {
    title: t('goal.wizard_title', { objective }),
    options: [
      { value: 'ai', label: t('goal.judge_ai'), description: t('goal.judge_ai_desc') },
      { value: 'shell', label: t('goal.judge_shell'), description: t('goal.judge_shell_desc') },
      { value: 'none', label: t('goal.judge_manual'), description: t('goal.judge_manual_desc') },
    ],
  });
}

async function pickShellCommand(host: SlashCommandHost, objective: string): Promise<string | undefined> {
  const { TextInputDialogComponent } = await import('../components/dialogs/text-input-dialog');
  return new Promise<string | undefined>((resolve) => {
    const dialog = new TextInputDialogComponent(
      (result) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' && result.value.trim().length > 0 ? result.value.trim() : undefined);
      },
      {
        title: t('goal.shell_command_prompt'),
        placeholder: 'pnpm test',
        allowEmpty: false,
        colors: host.state.theme.colors,
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

function pickChoice<T extends string>(host: SlashCommandHost, opts: { title: string; options: ChoiceOption[] }): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: opts.title,
      options: opts.options,
      colors: host.state.theme.colors,
      onSelect: (val: string) => {
        host.restoreEditor();
        resolve(val as T);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
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
