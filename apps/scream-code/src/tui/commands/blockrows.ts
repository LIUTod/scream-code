/**
 * /blockrows — Tune the activity block's row budgets: how tall a collapsed block
 * is, how much of a tool result and of a reasoning run an expanded block shows.
 *
 * Two steps: pick the budget, then pick the value. Choices are persisted to
 * ui-preferences.json (so they survive restarts) and applied to the transcript
 * that is already on screen, not just to blocks created afterwards.
 */

import { t } from '@scream-code/config';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  ACTIVITY_LINE_SETTINGS,
  findActivityLineSetting,
  getActivityLineValue,
  isActivityLineKey,
  setActivityLineValue,
} from '../utils/activity-lines';
import { repaintTranscript } from '../utils/transcript-repaint';

import type { ActivityLineKey } from '../utils/ui-preferences';
import type { SlashCommandHost } from './dispatch';

function showSettingPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('blockrows.title'),
      hint: t('blockrows.hint'),
      colors: host.state.theme.colors,
      options: ACTIVITY_LINE_SETTINGS.map((setting) => ({
        value: setting.key,
        label: t(setting.label),
        description: t('blockrows.current', {
          value: String(getActivityLineValue(setting.key)),
        }),
      })),
      onSelect: (value) => {
        if (isActivityLineKey(value)) showValuePicker(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function showValuePicker(host: SlashCommandHost, key: ActivityLineKey): void {
  const setting = findActivityLineSetting(key);
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t(setting.label),
      hint: t('blockrows.value_hint'),
      currentValue: String(getActivityLineValue(key)),
      colors: host.state.theme.colors,
      options: setting.values.map((value) => ({ value: String(value), label: String(value) })),
      onSelect: (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        setActivityLineValue(key, parsed);
        host.restoreEditor();
        host.showStatus(
          t('blockrows.saved', { label: t(setting.label), value: String(parsed) }),
          host.state.theme.colors.success,
        );
        repaintTranscript(host);
      },
      onCancel: () => {
        // Esc goes back one step instead of dropping out of the flow.
        showSettingPicker(host);
      },
    }),
  );
}

export async function handleBlockRowsCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  showSettingPicker(host);
}
