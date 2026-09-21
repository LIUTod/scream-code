/**
 * /cron — 定时任务面板：查看、新建、删除。
 *
 * 后端一直存在（`CronManager` + 模型侧的 CronCreate / CronList / CronDelete
 * 工具），但用户没有任何入口：任务只在「触发之后」往会话里注入一条消息时才
 * 露一次脸。这条命令是它的第一个面向用户的界面。
 *
 * 所有数据都走 `session.listCronTasks() / createCronTask() / removeCronTasks()`
 * —— 表达式、下次触发、校验文案全部来自核心，面板不可能和模型看到的规则
 * 不一致（两边的闸口是同一份 `tools/cron/schedule.ts`）。
 *
 * 裸 `/cron` 开列表；`add` 直接进向导；`rm <id>` 不经面板直接删。
 */

import { t } from '@scream-code/config';
import type { CronTaskInfo } from '@scream-code/scream-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { formatErrorMessage } from '../utils/event-payload';

import type { SlashCommandHost } from './dispatch';

type CronSession = NonNullable<SlashCommandHost['session']>;

/** Sentinel value for the "create one" row shown when the list is empty. */
const NEW_TASK_VALUE = '__cron_new__';

/** Sentinel value for the "type my own expression" row in the schedule step. */
const CUSTOM_SCHEDULE_VALUE = '__cron_custom__';

const PROMPT_PREVIEW_MAX = 60;

/**
 * Presets for the first wizard step. Deliberately short: the point is to cover
 * the shapes people actually want from a terminal ("every N minutes", "once a
 * day"), and send everything else to the raw-expression step, where the core's
 * parser produces the error message.
 */
const SCHEDULE_PRESETS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: '*/5 * * * *', labelKey: 'cron.sched_5m' },
  { value: '0 * * * *', labelKey: 'cron.sched_hourly' },
  { value: '0 9 * * *', labelKey: 'cron.sched_daily9' },
  { value: '0 18 * * *', labelKey: 'cron.sched_daily18' },
  { value: '0 9 * * 1-5', labelKey: 'cron.sched_weekdays9' },
  { value: CUSTOM_SCHEDULE_VALUE, labelKey: 'cron.sched_custom' },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Localized name for the schedule shapes we know, or `undefined` for anything
 * else. Unknown expressions are shown verbatim rather than guessed at — the
 * raw 5-field form is what the model, the tool output and the stored task all
 * show, so falling back to it keeps every surface consistent.
 */
function scheduleLabel(cron: string): string | undefined {
  const everyMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (everyMinutes !== null) {
    return t('cron.sched_every_minutes', { n: everyMinutes[1]! });
  }
  if (/^0 \* \* \* \*$/.test(cron)) return t('cron.sched_hourly');
  const weekdays = /^0 (\d{1,2}) \* \* 1-5$/.exec(cron);
  if (weekdays !== null) {
    return t('cron.sched_weekdays', { time: `${weekdays[1]!.padStart(2, '0')}:00` });
  }
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(cron);
  if (daily !== null) {
    return t('cron.sched_daily', { time: `${daily[1]!.padStart(2, '0')}:00` });
  }
  return undefined;
}

/** "in 3 minutes" / "3 分钟后", computed against the panel's own clock. */
function nextFireText(nextFireAt: number | null): string {
  if (nextFireAt === null) return t('cron.no_next_fire');
  const ms = nextFireAt - Date.now();
  if (ms <= 0) return t('cron.firing');
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t('cron.in_seconds', { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('cron.in_minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('cron.in_hours', { n: hours });
  return t('cron.in_days', { n: Math.round(hours / 24) });
}

function kindText(task: CronTaskInfo): string {
  return task.recurring ? t('cron.kind_recurring') : t('cron.kind_once');
}

/** One dim description line: schedule · next fire · kind · stale · prompt. */
function describeTask(task: CronTaskInfo): string {
  return [
    scheduleLabel(task.cron),
    nextFireText(task.nextFireAt),
    kindText(task),
    task.stale ? t('cron.stale') : undefined,
    truncate(singleLine(task.prompt), PROMPT_PREVIEW_MAX),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('  ·  ');
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function toOption(task: CronTaskInfo, host: SlashCommandHost, session: CronSession): ChoiceOption {
  return {
    value: task.id,
    // The expression is the label, not a translation of it: this is the same
    // string the model writes and the tool output reports.
    label: task.cron,
    description: describeTask(task),
    actionKeys: {
      d: () => {
        host.restoreEditor();
        void deleteTask(host, session, task);
      },
    },
  };
}

async function openPanel(host: SlashCommandHost, session: CronSession): Promise<void> {
  let tasks: readonly CronTaskInfo[];
  try {
    tasks = await session.listCronTasks();
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }

  const options: ChoiceOption[] =
    tasks.length === 0
      ? [{ value: NEW_TASK_VALUE, label: t('cron.empty'), description: t('cron.empty_hint') }]
      : tasks.map((task) => toOption(task, host, session));

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('cron.panel_title'),
      hint: t('cron.panel_hint'),
      options,
      colors: host.state.theme.colors,
      searchable: true,
      onSelect: (value: string) => {
        host.restoreEditor();
        void handleSelect(host, session, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function handleSelect(
  host: SlashCommandHost,
  session: CronSession,
  value: string,
): Promise<void> {
  if (value === NEW_TASK_VALUE) {
    await runWizard(host, session);
    return;
  }
  // Selecting a task row has no detail view yet — refresh so a stray Enter on
  // a row does not leave the panel in a dead state.
  await openPanel(host, session);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function confirmDelete(host: SlashCommandHost, task: CronTaskInfo): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('cron.confirm_title'),
      hint: t('cron.confirm_hint'),
      options: [
        { value: 'no', label: t('common.cancel') },
        {
          value: 'yes',
          label: t('cron.confirm_delete'),
          tone: 'danger' as const,
          description: `${task.cron}  ·  ${truncate(singleLine(task.prompt), PROMPT_PREVIEW_MAX)}`,
        },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        host.restoreEditor();
        resolve(value === 'yes');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function deleteTask(
  host: SlashCommandHost,
  session: CronSession,
  task: CronTaskInfo,
): Promise<void> {
  const confirmed = await confirmDelete(host, task);
  if (!confirmed) {
    await openPanel(host, session);
    return;
  }

  const spinner = host.showProgressSpinner(t('cron.deleting'));
  try {
    const removed = await session.removeCronTasks([task.id]);
    if (removed.length === 0) {
      spinner.stop({ ok: false, label: t('cron.not_found') });
    } else {
      spinner.stop({ ok: true, label: t('cron.deleted') });
    }
  } catch (error) {
    spinner.stop({ ok: false, label: t('cron.delete_failed') });
    host.showError(formatErrorMessage(error));
  } finally {
    await openPanel(host, session);
  }
}

// ---------------------------------------------------------------------------
// Create wizard
// ---------------------------------------------------------------------------

function promptTextInput(
  host: SlashCommandHost,
  title: string,
  opts?: { subtitle?: string; placeholder?: string },
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const dialog = new TextInputDialogComponent(
    (result) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    },
    {
      title,
      subtitle: opts?.subtitle,
      placeholder: opts?.placeholder,
      colors: host.state.theme.colors,
    },
  );
  host.mountEditorReplacement(dialog);
  return promise;
}

function pickFrom(host: SlashCommandHost, title: string, hint: string, options: ChoiceOption[]): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title,
      hint,
      options,
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    }),
  );
  return promise;
}

/** Step 1: pick a cadence, or type an expression. */
async function pickSchedule(host: SlashCommandHost): Promise<string | undefined> {
  const value = await pickFrom(
    host,
    t('cron.wizard_schedule_title'),
    t('cron.wizard_schedule_hint'),
    SCHEDULE_PRESETS.map((preset) => ({
      value: preset.value,
      label: t(preset.labelKey),
      description: preset.value === CUSTOM_SCHEDULE_VALUE ? t('cron.sched_custom_hint') : preset.value,
    })),
  );
  if (value === undefined) return undefined;
  if (value !== CUSTOM_SCHEDULE_VALUE) return value;

  const custom = await promptTextInput(host, t('cron.wizard_custom_title'), {
    subtitle: t('cron.wizard_custom_hint'),
    placeholder: '*/5 * * * *',
  });
  if (custom === undefined) return undefined;
  const trimmed = custom.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Step 3: repeat, or fire once. */
async function pickKind(host: SlashCommandHost): Promise<boolean | undefined> {
  const value = await pickFrom(host, t('cron.wizard_kind_title'), t('cron.wizard_kind_hint'), [
    { value: 'recurring', label: t('cron.kind_recurring'), description: t('cron.kind_recurring_hint') },
    { value: 'once', label: t('cron.kind_once'), description: t('cron.kind_once_hint') },
  ]);
  if (value === undefined) return undefined;
  return value === 'recurring';
}

async function runWizard(host: SlashCommandHost, session: CronSession): Promise<void> {
  const cron = await pickSchedule(host);
  if (cron === undefined) {
    host.showStatus(t('cron.cancelled'), host.state.theme.colors.textDim);
    await openPanel(host, session);
    return;
  }

  const prompt = await promptTextInput(host, t('cron.wizard_task_title'), {
    subtitle: cron,
    placeholder: t('cron.wizard_task_placeholder'),
  });
  const trimmedPrompt = prompt?.trim();
  if (trimmedPrompt === undefined || trimmedPrompt.length === 0) {
    host.showStatus(t('cron.cancelled'), host.state.theme.colors.textDim);
    await openPanel(host, session);
    return;
  }

  const recurring = await pickKind(host);
  if (recurring === undefined) {
    host.showStatus(t('cron.cancelled'), host.state.theme.colors.textDim);
    await openPanel(host, session);
    return;
  }

  const spinner = host.showProgressSpinner(t('cron.creating'));
  try {
    const task = await session.createCronTask({ cron, prompt: trimmedPrompt, recurring });
    spinner.stop({ ok: true, label: t('cron.created') });
    host.showNotice(t('cron.created'), describeTask(task));
  } catch (error) {
    // Validation errors are the core's own sentences (shared with the model's
    // CronCreate tool), so show them verbatim instead of rewording here.
    spinner.stop({ ok: false, label: t('cron.create_failed') });
    host.showError(formatErrorMessage(error));
  } finally {
    await openPanel(host, session);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Delete straight from the command line; the id is explicit, so no confirm. */
async function removeById(host: SlashCommandHost, session: CronSession, id: string): Promise<void> {
  try {
    const removed = await session.removeCronTasks([id]);
    if (removed.length === 0) {
      host.showStatus(t('cron.not_found'), host.state.theme.colors.textDim);
      return;
    }
    host.showNotice(t('cron.deleted'), id);
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

export async function handleCronCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(t('cron.no_session'));
    return;
  }

  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);

  switch (sub.toLowerCase()) {
    case '':
    case 'list':
      await openPanel(host, session);
      return;
    case 'add':
    case 'new':
      await runWizard(host, session);
      return;
    case 'rm':
    case 'remove':
    case 'delete': {
      const id = rest[0];
      if (id === undefined || id.length === 0) {
        host.showStatus(t('cron.usage'), host.state.theme.colors.textDim);
        return;
      }
      await removeById(host, session, id);
      return;
    }
    default:
      host.showStatus(t('cron.usage'), host.state.theme.colors.textDim);
  }
}
