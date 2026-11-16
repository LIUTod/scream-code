import { t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { handleBudgetCommand } from '#/tui/commands/budget';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { TextInputDialogComponent } from '#/tui/components/dialogs/text-input-dialog';

import { makeMockHarness, makeMockSession, makeMockSlashCommandHost } from '../fixtures/mock-host';

const DOWN = '\u001B[B';
const ENTER = '\r';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface Setup {
  readonly host: ReturnType<typeof makeMockSlashCommandHost>;
  readonly setLive: ReturnType<typeof vi.fn>;
  readonly setConfig: ReturnType<typeof vi.fn>;
}

const NO_LIMIT = { usedTokens: 0, limitTokens: null } as const;

/** A host whose session reports `used`/`limit` and records every change. */
function setup(
  budget: { usedTokens: number; limitTokens: number | null } = NO_LIMIT,
  failures: { live?: Error; save?: Error } = {},
): Setup {
  const setLive = vi.fn(async (limit: number | null) => {
    if (failures.live !== undefined) throw failures.live;
    return { usedTokens: budget.usedTokens, limitTokens: limit };
  });
  const setConfig = vi.fn(async () => {
    if (failures.save !== undefined) throw failures.save;
  });
  const session = makeMockSession({
    overrides: {
      getSessionTokenBudget: vi.fn(async () => budget),
      setSessionTokenBudget: setLive,
    },
  });
  const host = makeMockSlashCommandHost({
    session,
    harness: makeMockHarness({ setConfig }),
  });
  return { host, setLive, setConfig };
}

function mounted(host: Setup['host'], call = 0): unknown {
  return vi.mocked(host.mountEditorReplacement).mock.calls[call]?.[0];
}

describe('/budget <value>', () => {
  it('applies a limit to the live session and saves it as the default', async () => {
    const { host, setLive, setConfig } = setup();

    await handleBudgetCommand(host, '50m');

    expect(setLive).toHaveBeenCalledWith(50_000_000);
    expect(setConfig).toHaveBeenCalledWith({ loopControl: { maxSessionTokens: 50_000_000 } });
    expect(host.showStatus).toHaveBeenCalledWith(t('budget.set', { limit: '50M' }));
    expect(host.showError).not.toHaveBeenCalled();
  });

  it.each([
    ['500k', 500_000],
    ['1.5b', 1_500_000_000],
    ['500万', 5_000_000],
    ['  20 M ', 20_000_000],
    ['120000000', 120_000_000],
  ])('reads %j as %d tokens', async (input, tokens) => {
    const { host, setLive } = setup();

    await handleBudgetCommand(host, input);

    expect(setLive).toHaveBeenCalledWith(tokens);
  });

  it.each(['off', '0', '关闭'])('treats %j as "no limit" and persists 0', async (input) => {
    const { host, setLive, setConfig } = setup({ usedTokens: 10, limitTokens: 5_000 });

    await handleBudgetCommand(host, input);

    expect(setLive).toHaveBeenCalledWith(null);
    // A config patch deep-merges and cannot delete a key, so "off" is stored as 0.
    expect(setConfig).toHaveBeenCalledWith({ loopControl: { maxSessionTokens: 0 } });
    expect(host.showStatus).toHaveBeenCalledWith(t('budget.cleared'));
  });

  it('rejects something that is not a token count and changes nothing', async () => {
    const { host, setLive, setConfig } = setup();

    await handleBudgetCommand(host, '$5');

    expect(host.showError).toHaveBeenCalledWith(t('budget.invalid', { input: '$5' }));
    expect(setLive).not.toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('says so when the new limit is already below what this run used', async () => {
    const { host } = setup({ usedTokens: 3_000_000, limitTokens: null });

    await handleBudgetCommand(host, '1m');

    expect(host.showStatus).toHaveBeenCalledWith(
      t('budget.already_over', { used: '3.0M' }),
      host.state.theme.colors.warning,
    );
  });

  it('does not warn when the limit is above what was used', async () => {
    const { host } = setup({ usedTokens: 3_000_000, limitTokens: null });

    await handleBudgetCommand(host, '50m');

    expect(host.showStatus).toHaveBeenCalledTimes(1);
  });

  it('reports a failed save as exactly that — the limit still holds for this session', async () => {
    const { host, setLive } = setup(undefined, { save: new Error('disk full') });

    await handleBudgetCommand(host, '50m');

    expect(setLive).toHaveBeenCalledWith(50_000_000);
    expect(host.showStatus).toHaveBeenCalledWith(
      t('budget.save_failed', { error: 'disk full' }),
      host.state.theme.colors.warning,
    );
    expect(host.showStatus).not.toHaveBeenCalledWith(t('budget.set', { limit: '50M' }));
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('does not save a default when the live session refused the change', async () => {
    const { host, setConfig } = setup(undefined, { live: new Error('session closed') });

    await handleBudgetCommand(host, '50m');

    expect(host.showError).toHaveBeenCalledWith(t('budget.apply_failed', { error: 'session closed' }));
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('with no live session, still saves the default for new sessions', async () => {
    const setConfig = vi.fn(async () => {});
    const host = makeMockSlashCommandHost({ harness: makeMockHarness({ setConfig }) });

    await handleBudgetCommand(host, '50m');

    expect(setConfig).toHaveBeenCalledWith({ loopControl: { maxSessionTokens: 50_000_000 } });
    expect(host.showStatus).toHaveBeenCalledWith(t('budget.set', { limit: '50M' }));
  });
});

describe('/budget (picker)', () => {
  it('opens a picker that shows what this run used and the current limit', async () => {
    const { host } = setup({ usedTokens: 1_500_000, limitTokens: 50_000_000 });

    await handleBudgetCommand(host, '');

    const picker = mounted(host);
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    const rendered = strip((picker as ChoicePickerComponent).render(100).join('\n'));
    expect(rendered).toContain(t('budget.picker_title'));
    expect(rendered).toContain(t('budget.status', { used: '1.5M', limit: '50M' }));
    expect(rendered).toContain(t('budget.option_off'));
    for (const preset of ['10M', '50M', '100M', '500M', '1B']) expect(rendered).toContain(preset);
    expect(rendered).toContain(t('budget.option_custom'));
  });

  it('shows "none" when no limit is set', async () => {
    const { host } = setup({ usedTokens: 0, limitTokens: null });

    await handleBudgetCommand(host, '');

    const rendered = strip((mounted(host) as ChoicePickerComponent).render(100).join('\n'));
    expect(rendered).toContain(t('budget.status', { used: '0', limit: t('budget.limit_none') }));
  });

  it('lists a hand-set limit that is not a preset, so "current" has somewhere to land', async () => {
    const { host } = setup({ usedTokens: 0, limitTokens: 123_000_000 });

    await handleBudgetCommand(host, '');

    const rendered = strip((mounted(host) as ChoicePickerComponent).render(100).join('\n'));
    expect(rendered).toContain('123M');
  });

  it('falls back to the saved default when there is no live session', async () => {
    const host = makeMockSlashCommandHost({
      harness: makeMockHarness({
        getConfig: vi.fn(async () => ({ providers: {}, loopControl: { maxSessionTokens: 100_000_000 } })),
      }),
    });

    await handleBudgetCommand(host, '');

    const rendered = strip((mounted(host) as ChoicePickerComponent).render(100).join('\n'));
    expect(rendered).toContain(t('budget.status', { used: '0', limit: '100M' }));
  });

  it('applies the highlighted preset on Enter', async () => {
    const { host, setLive, setConfig } = setup({ usedTokens: 0, limitTokens: 50_000_000 });

    await handleBudgetCommand(host, '');
    const picker = mounted(host) as ChoicePickerComponent;
    picker.handleInput(DOWN); // 50M (current) → 100M
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(setLive).toHaveBeenCalledWith(100_000_000);
    });
    expect(setConfig).toHaveBeenCalledWith({ loopControl: { maxSessionTokens: 100_000_000 } });
    expect(host.restoreEditor).toHaveBeenCalled();
  });

  it('turns the limit off from the list', async () => {
    const { host, setLive } = setup({ usedTokens: 0, limitTokens: 10_000_000 });

    await handleBudgetCommand(host, '');
    const picker = mounted(host) as ChoicePickerComponent;
    picker.handleInput('\u001B[A'); // 10M (current) → "No limit"
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(setLive).toHaveBeenCalledWith(null);
    });
  });

  it('cancelling the picker changes nothing', async () => {
    const { host, setLive, setConfig } = setup();

    await handleBudgetCommand(host, '');
    (mounted(host) as ChoicePickerComponent).handleInput('\u001B');

    await vi.waitFor(() => {
      expect(host.restoreEditor).toHaveBeenCalled();
    });
    expect(setLive).not.toHaveBeenCalled();
    expect(setConfig).not.toHaveBeenCalled();
  });
});

describe('/budget → Custom…', () => {
  /** Walk the picker down to its last entry ("Custom…") and select it. */
  async function openCustom(s: Setup): Promise<TextInputDialogComponent> {
    await handleBudgetCommand(s.host, '');
    const picker = mounted(s.host) as ChoicePickerComponent;
    for (let i = 0; i < 12; i++) picker.handleInput(DOWN); // clamps at the last entry
    picker.handleInput(ENTER);
    await vi.waitFor(() => {
      expect(mounted(s.host, 1)).toBeInstanceOf(TextInputDialogComponent);
    });
    return mounted(s.host, 1) as TextInputDialogComponent;
  }

  function type(dialog: TextInputDialogComponent, text: string): void {
    for (const char of text) dialog.handleInput(char);
    dialog.handleInput(ENTER);
  }

  it('applies what the user types', async () => {
    const s = setup();
    const dialog = await openCustom(s);

    type(dialog, '3b');

    await vi.waitFor(() => {
      expect(s.setLive).toHaveBeenCalledWith(3_000_000_000);
    });
    expect(s.setConfig).toHaveBeenCalledWith({ loopControl: { maxSessionTokens: 3_000_000_000 } });
  });

  it('re-opens with the typed text and the reason when the value is bad', async () => {
    const s = setup();
    const dialog = await openCustom(s);

    type(dialog, 'lots');

    await vi.waitFor(() => {
      expect(mounted(s.host, 2)).toBeInstanceOf(TextInputDialogComponent);
    });
    const again = strip((mounted(s.host, 2) as TextInputDialogComponent).render(100).join('\n'));
    expect(again).toContain(t('budget.custom_invalid', { input: 'lots' }));
    expect(again).toContain('lots');
    expect(s.setLive).not.toHaveBeenCalled();
  });
});
