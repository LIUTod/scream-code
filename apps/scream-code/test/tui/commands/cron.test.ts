/**
 * `/cron` — the first user-facing surface for scheduled tasks.
 *
 * The command is thin by design: everything it shows comes from
 * `session.listCronTasks()` and every write goes through
 * `createCronTask()` / `removeCronTasks()`, so these tests drive the panel
 * through the host seam and assert both what the user sees and what the core
 * was asked to do.
 */
import { t } from '@scream-code/config';
import type { CronTaskInfo } from '@scream-code/scream-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { handleCronCommand } from '#/tui/commands/cron';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand } from '#/tui/commands/registry';
import { darkColors } from '#/tui/theme/colors';

/** The panels keep their callbacks on a private field; this is the seam. */
interface PickerHandle {
  render(width: number): string[];
  opts: {
    onSelect(value: string): void;
    onCancel(): void;
    options: Array<{ value: string; actionKeys?: { d(): void } }>;
  };
}

interface InputHandle {
  onDone(result: { kind: 'ok'; value: string } | { kind: 'cancel' }): void;
}

const ANSI = /\u001B\[[0-9;]*m/g;
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function task(overrides: Partial<CronTaskInfo> = {}): CronTaskInfo {
  return {
    id: 'abcd1234',
    cron: '*/5 * * * *',
    prompt: 'check CI and report failures',
    createdAt: 1_700_000_000_000,
    recurring: true,
    stale: false,
    nextFireAt: Date.now() + 5 * 60_000,
    ...overrides,
  };
}

function makeHost(tasks: readonly CronTaskInfo[], opts: { readonly session?: boolean } = {}) {
  const listCronTasks = vi.fn(async () => tasks);
  const createCronTask = vi.fn(async () => task());
  const removeCronTasks = vi.fn(async (ids: readonly string[]) => [...ids]);
  const mounted: unknown[] = [];
  const notices: Array<[string, string | undefined]> = [];
  const errors: string[] = [];

  const host = {
    session:
      opts.session === false
        ? undefined
        : { listCronTasks, createCronTask, removeCronTasks },
    state: {
      theme: { colors: darkColors },
      transcriptContainer: { children: [{ invalidate: vi.fn() }] },
      ui: { requestRender: vi.fn() },
    },
    showStatus: vi.fn(),
    showNotice: vi.fn((title: string, detail?: string) => {
      notices.push([title, detail]);
    }),
    showError: vi.fn((message: string) => {
      errors.push(message);
    }),
    showProgressSpinner: vi.fn(() => ({ stop: vi.fn() })),
    mountEditorReplacement: (panel: unknown) => {
      mounted.push(panel);
    },
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;

  return { host, mounted, notices, errors, listCronTasks, createCronTask, removeCronTasks };
}

function panelText(mounted: unknown[], index: number): string {
  const panel = mounted[index] as PickerHandle;
  return panel
    .render(80)
    .map((line) => line.replaceAll(ANSI, ''))
    .join('\n');
}

describe('/cron list', () => {
  it('lists the tasks the session reports, expression first', async () => {
    const { host, mounted } = makeHost([task()]);
    await handleCronCommand(host, '');

    const text = panelText(mounted, 0);
    expect(text).toContain(t('cron.panel_title'));
    expect(text).toContain('*/5 * * * *');
    // The description carries the derived bits: schedule, next fire, kind and
    // a prompt preview.
    expect(text).toContain(t('cron.sched_every_minutes', { n: '5' }));
    expect(text).toContain(t('cron.kind_recurring'));
    expect(text).toContain('check CI and report failures');
  });

  it('marks one-shot and expired tasks', async () => {
    const { host, mounted } = makeHost([
      task({ id: 'once0001', cron: '0 9 * * *', recurring: false, stale: true }),
    ]);
    await handleCronCommand(host, 'list');

    const text = panelText(mounted, 0);
    expect(text).toContain(t('cron.kind_once'));
    expect(text).toContain(t('cron.stale'));
  });

  it('offers a create row when there is nothing scheduled', async () => {
    const { host, mounted } = makeHost([]);
    await handleCronCommand(host, '');

    const text = panelText(mounted, 0);
    expect(text).toContain(t('cron.empty'));
    expect(text).toContain(t('cron.empty_hint'));
  });

  it('starts the wizard when the empty-state row is chosen', async () => {
    const { host, mounted } = makeHost([]);
    const run = handleCronCommand(host, '');
    await tick();

    const only = (mounted[0] as PickerHandle).opts.options[0]!;
    (mounted[0] as PickerHandle).opts.onSelect(only.value);
    await tick();

    // Step 1 of the wizard is on screen, not another copy of the empty panel.
    expect(panelText(mounted, 1)).toContain(t('cron.wizard_schedule_title'));

    (mounted[1] as PickerHandle).opts.onCancel();
    await run;
  });

  it('re-reads the list when a row is opened', async () => {
    const { host, mounted, listCronTasks } = makeHost([task()]);
    await handleCronCommand(host, '');
    expect(listCronTasks).toHaveBeenCalledTimes(1);

    (mounted[0] as PickerHandle).opts.onSelect('abcd1234');
    await tick();

    expect(listCronTasks).toHaveBeenCalledTimes(2);
  });
});

describe('/cron delete', () => {
  it('asks first, then deletes and reopens the panel', async () => {
    const { host, mounted, removeCronTasks, listCronTasks } = makeHost([task()]);
    await handleCronCommand(host, '');

    const row = (mounted[0] as PickerHandle).opts.options[0]!;
    row.actionKeys!.d();
    await tick();

    // A confirmation panel, not an immediate delete.
    expect(removeCronTasks).not.toHaveBeenCalled();
    expect(panelText(mounted, 1)).toContain(t('cron.confirm_title'));

    (mounted[1] as PickerHandle).opts.onSelect('yes');
    await tick();
    await tick();

    expect(removeCronTasks).toHaveBeenCalledWith(['abcd1234']);
    // The panel is back, showing the fresh list rather than a stale one.
    expect(listCronTasks).toHaveBeenCalledTimes(2);
    expect(panelText(mounted, mounted.length - 1)).toContain('*/5 * * * *');
  });

  it('reopens the panel, unchanged, when the confirmation is declined', async () => {
    const { host, mounted, removeCronTasks, listCronTasks } = makeHost([task()]);
    await handleCronCommand(host, '');

    (mounted[0] as PickerHandle).opts.options[0]!.actionKeys!.d();
    await tick();
    (mounted[1] as PickerHandle).opts.onSelect('no');
    await tick();
    await tick();

    expect(removeCronTasks).not.toHaveBeenCalled();
    expect(listCronTasks).toHaveBeenCalledTimes(2);
    expect(panelText(mounted, mounted.length - 1)).toContain('*/5 * * * *');
  });

  it('/cron rm <id> deletes straight away, and reports an unknown id', async () => {
    const { host, removeCronTasks, notices } = makeHost([task()]);

    await handleCronCommand(host, 'rm abcd1234');
    expect(removeCronTasks).toHaveBeenCalledWith(['abcd1234']);
    expect(notices.at(-1)?.[0]).toBe(t('cron.deleted'));

    removeCronTasks.mockResolvedValueOnce([]);
    await handleCronCommand(host, 'rm deadbeef');
    expect(host.showStatus).toHaveBeenLastCalledWith(t('cron.not_found'), darkColors.textDim);
  });

  it('/cron rm without an id prints the usage line', async () => {
    const { host, removeCronTasks } = makeHost([task()]);
    await handleCronCommand(host, 'rm');
    expect(removeCronTasks).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenLastCalledWith(t('cron.usage'), darkColors.textDim);
  });
});

describe('/cron add wizard', () => {
  it('takes a preset, a task and the one-shot flag', async () => {
    const { host, mounted, createCronTask } = makeHost([]);
    const run = handleCronCommand(host, 'add');
    await tick();

    // Step 1: schedule.
    expect(panelText(mounted, 0)).toContain(t('cron.wizard_schedule_title'));
    (mounted[0] as PickerHandle).opts.onSelect('*/5 * * * *');
    await tick();

    // Step 2: what to do.
    (mounted[1] as InputHandle).onDone({ kind: 'ok', value: '  check CI  ' });
    await tick();

    // Step 3: once or repeating.
    expect(panelText(mounted, 2)).toContain(t('cron.wizard_kind_title'));
    (mounted[2] as PickerHandle).opts.onSelect('once');
    await run;

    expect(createCronTask).toHaveBeenCalledWith({
      cron: '*/5 * * * *',
      prompt: 'check CI',
      recurring: false,
    });
  });

  it('accepts a hand-written expression when the custom row is picked', async () => {
    const { host, mounted, createCronTask } = makeHost([]);
    const run = handleCronCommand(host, 'add');
    await tick();

    const custom = (mounted[0] as PickerHandle).opts.options.at(-1)!;
    expect(custom.value).not.toBe('*/5 * * * *');
    (mounted[0] as PickerHandle).opts.onSelect(custom.value);
    await tick();

    (mounted[1] as InputHandle).onDone({ kind: 'ok', value: '  0 3 * * 2  ' });
    await tick();
    (mounted[2] as InputHandle).onDone({ kind: 'ok', value: 'weekly review' });
    await tick();
    (mounted[3] as PickerHandle).opts.onSelect('recurring');
    await run;

    expect(createCronTask).toHaveBeenCalledWith({
      cron: '0 3 * * 2',
      prompt: 'weekly review',
      recurring: true,
    });
  });

  it('cancelling the schedule step creates nothing', async () => {
    const { host, mounted, createCronTask } = makeHost([]);
    const run = handleCronCommand(host, 'add');
    await tick();

    (mounted[0] as PickerHandle).opts.onCancel();
    await run;

    expect(createCronTask).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(t('cron.cancelled'), darkColors.textDim);
  });

  it('cancelling the task step creates nothing', async () => {
    const { host, mounted, createCronTask } = makeHost([]);
    const run = handleCronCommand(host, 'add');
    await tick();
    (mounted[0] as PickerHandle).opts.onSelect('*/5 * * * *');
    await tick();

    (mounted[1] as InputHandle).onDone({ kind: 'cancel' });
    await run;

    expect(createCronTask).not.toHaveBeenCalled();
  });

  it('surfaces the core rejection verbatim', async () => {
    const { host, mounted, createCronTask, errors } = makeHost([]);
    createCronTask.mockRejectedValueOnce(new Error('[cron.invalid] Invalid cron expression: bad'));

    const run = handleCronCommand(host, 'add');
    await tick();
    (mounted[0] as PickerHandle).opts.onSelect('*/5 * * * *');
    await tick();
    (mounted[1] as InputHandle).onDone({ kind: 'ok', value: 'x' });
    await tick();
    (mounted[2] as PickerHandle).opts.onSelect('recurring');
    await run;

    expect(errors.at(-1)).toContain('Invalid cron expression: bad');
  });
});

describe('/cron guards', () => {
  it('is registered so it shows up in the command palette', () => {
    expect(findBuiltInSlashCommand('cron')).toMatchObject({
      name: 'cron',
      aliases: ['crontab'],
      description: 'registry.cron_desc',
    });
  });

  it('reports a missing session instead of throwing', async () => {
    const { host, errors } = makeHost([], { session: false });
    await handleCronCommand(host, '');
    expect(errors).toEqual([t('cron.no_session')]);
  });

  it('prints usage for an unknown subcommand', async () => {
    const { host, listCronTasks } = makeHost([task()]);
    await handleCronCommand(host, 'wat');
    expect(listCronTasks).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenLastCalledWith(t('cron.usage'), darkColors.textDim);
  });

  it('surfaces a list failure instead of mounting an empty panel', async () => {
    const { host, mounted, errors, listCronTasks } = makeHost([task()]);
    listCronTasks.mockRejectedValueOnce(new Error('[cron.unavailable] nope'));

    await handleCronCommand(host, '');

    expect(mounted).toHaveLength(0);
    expect(errors.at(-1)).toContain('cron.unavailable');
  });
});
