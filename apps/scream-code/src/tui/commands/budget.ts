/**
 * `/budget` — set the token limit of the running session.
 *
 *   /budget          pick a preset (or "custom") from a list
 *   /budget 50m      set it directly: 500k, 20m, 1.5b, 500万 …
 *   /budget off      remove the limit (0 means the same)
 *
 * The change applies to the live session at once — raising the limit clears a
 * tripped one without a restart — and is saved as `loop_control.max_session_tokens`
 * so new sessions start with it. The unit is tokens, not money: a dollar limit
 * needs a catalog price, which custom providers do not have.
 *
 * Tokens are counted the way `/usage` shows them (input including cache reads,
 * plus output), for this run of the session: the main agent, every subagent,
 * compaction and the cache warmer.
 */

import { t } from '@scream-code/config';
import type { SessionTokenBudget } from '@scream-code/scream-code-sdk';

import { formatTokenLimit, parseTokenLimit } from '#/utils/usage/token-limit';
import { formatTokenCount } from '#/utils/usage/usage-format';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * Picker presets. Cache reads count toward the total (as in `/usage`) and every
 * agent step re-sends the context, so a busy session moves tens of millions of
 * tokens — the steps are sized for that, not for a chat.
 */
const PRESET_LIMITS: readonly number[] = [10_000_000, 50_000_000, 100_000_000, 500_000_000, 1_000_000_000];

const VALUE_OFF = 'off';
const VALUE_CUSTOM = 'custom';

export async function handleBudgetCommand(host: SlashCommandHost, args: string): Promise<void> {
  const typed = args.trim();
  if (typed === '') {
    await openBudgetPicker(host);
    return;
  }
  const parsed = parseTokenLimit(typed);
  if (parsed.kind === 'invalid') {
    host.showError(t('budget.invalid', { input: typed }));
    return;
  }
  await applyTokenLimit(host, parsed.kind === 'off' ? null : parsed.tokens);
}

/** What the picker shows as "current": the live session when there is one, else the saved default. */
async function readBudget(host: SlashCommandHost): Promise<SessionTokenBudget> {
  if (host.session !== undefined) {
    try {
      return await host.session.getSessionTokenBudget();
    } catch {
      // Fall through to the saved default: a picker that cannot open is worse
      // than one that shows the configured limit and zero usage.
    }
  }
  let limitTokens: number | null = null;
  try {
    const configured = (await host.harness.getConfig()).loopControl?.maxSessionTokens;
    limitTokens = configured !== undefined && configured > 0 ? configured : null;
  } catch {
    // Unreadable config: show the limit as unset.
  }
  return { usedTokens: 0, limitTokens };
}

function buildOptions(current: number | null): ChoiceOption[] {
  // A limit set by hand (`/budget 123m`) is not a preset: list it too, in order,
  // so the "← current" mark has somewhere to land.
  const limits = new Set(PRESET_LIMITS);
  if (current !== null) limits.add(current);
  return [
    { value: VALUE_OFF, label: t('budget.option_off') },
    ...[...limits]
      .toSorted((a, b) => a - b)
      .map((tokens) => ({ value: String(tokens), label: formatTokenLimit(tokens) })),
    { value: VALUE_CUSTOM, label: t('budget.option_custom') },
  ];
}

async function openBudgetPicker(host: SlashCommandHost): Promise<void> {
  const budget = await readBudget(host);
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('budget.picker_title'),
      hint: t('budget.picker_hint'),
      notice: t('budget.status', {
        used: formatTokenCount(budget.usedTokens),
        limit: budget.limitTokens === null ? t('budget.limit_none') : formatTokenLimit(budget.limitTokens),
      }),
      options: buildOptions(budget.limitTokens),
      currentValue: budget.limitTokens === null ? VALUE_OFF : String(budget.limitTokens),
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void handleChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function handleChoice(host: SlashCommandHost, value: string): Promise<void> {
  if (value === VALUE_CUSTOM) {
    await promptCustomLimit(host);
    return;
  }
  if (value === VALUE_OFF) {
    await applyTokenLimit(host, null);
    return;
  }
  const tokens = Number(value);
  if (Number.isSafeInteger(tokens) && tokens > 0) await applyTokenLimit(host, tokens);
}

/**
 * Free-form entry. A bad value re-opens the dialog with what the user typed and
 * the reason, instead of ending the command and making them start over.
 */
function promptCustomLimit(host: SlashCommandHost, initial = '', problem?: string): Promise<void> {
  return new Promise<void>((resolve) => {
    host.mountEditorReplacement(
      new TextInputDialogComponent(
        (result) => {
          host.restoreEditor();
          if (result.kind !== 'ok') {
            resolve();
            return;
          }
          const parsed = parseTokenLimit(result.value);
          if (parsed.kind === 'invalid') {
            void promptCustomLimit(
              host,
              result.value,
              t('budget.custom_invalid', { input: result.value.trim() }),
            ).then(resolve);
            return;
          }
          void applyTokenLimit(host, parsed.kind === 'off' ? null : parsed.tokens).then(resolve);
        },
        {
          title: t('budget.custom_title'),
          subtitle: problem ?? t('budget.custom_subtitle'),
          placeholder: '50m',
          allowEmpty: false,
          colors: host.state.theme.colors,
          ...(initial === '' ? {} : { initialValue: initial }),
        },
      ),
    );
  });
}

/**
 * Apply to the live session first (that is what the user feels), then save the
 * default. A failed save is reported as exactly that — the limit still holds
 * for this session — rather than as a failure of the whole command.
 */
async function applyTokenLimit(host: SlashCommandHost, limit: number | null): Promise<void> {
  const colors = host.state.theme.colors;

  let live: SessionTokenBudget | undefined;
  if (host.session !== undefined) {
    try {
      live = await host.session.setSessionTokenBudget(limit);
    } catch (error) {
      host.showError(t('budget.apply_failed', { error: formatErrorMessage(error) }));
      return;
    }
  }

  let saveError: string | undefined;
  try {
    // 0 is how "no limit" is persisted: a config patch deep-merges and cannot delete a key.
    await host.harness.setConfig({ loopControl: { maxSessionTokens: limit ?? 0 } });
  } catch (error) {
    saveError = formatErrorMessage(error);
  }

  if (saveError !== undefined) {
    host.showStatus(t('budget.save_failed', { error: saveError }), colors.warning);
  } else {
    host.showStatus(limit === null ? t('budget.cleared') : t('budget.set', { limit: formatTokenLimit(limit) }));
  }
  if (limit !== null && live !== undefined && live.usedTokens >= limit) {
    // Setting a limit below what this run already used pauses requests at once —
    // true to the request, but a surprise unless it is said out loud.
    host.showStatus(t('budget.already_over', { used: formatTokenCount(live.usedTokens) }), colors.warning);
  }
}
