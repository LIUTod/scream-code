import { t, setLocale, getLocale, type Locale } from '@scream-code/config';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { loadTuiConfig, saveTuiConfig } from '../config';
import { formatErrorMessage } from '../utils/event-payload';
import { flashStatus } from '../utils/flash-status';
import type { SlashCommandHost } from './dispatch';

const LANGUAGE_OPTIONS: readonly ChoiceOption[] = [
  { value: 'zh', label: '中文 Chinese' },
  { value: 'en', label: 'English 英文' },
];

export function handleLanguageCommand(host: SlashCommandHost, back?: () => void): void {
  const current = getLocale();
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('language.picker_title'),
      // From /settings the default hint applies, which says Esc goes back.
      hint: back === undefined ? t('language.picker_hint') : undefined,
      options: [...LANGUAGE_OPTIONS],
      currentValue: current,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyLanguageChoice(host, value as Locale);
      },
      onCancel: () => {
        host.restoreEditor();
        back?.();
      },
      breadcrumb: back === undefined ? undefined : t('settings.title'),
    }),
  );
}

async function applyLanguageChoice(host: SlashCommandHost, locale: Locale): Promise<void> {
  if (locale === getLocale()) {
    flashStatus(host, t('language.unchanged', { locale }));
    return;
  }

  try {
    setLocale(locale);
    host.state.appState.language = locale;
    await saveTuiConfig({
      ...(await loadTuiConfig()),
      theme: host.state.appState.theme,
      language: locale,
      editorCommand: host.state.appState.editorCommand,
      notifications: host.state.appState.notifications,
      like: host.state.appState.like,
      fusionPlan: host.state.appState.fusionPlan,
      subagentModels: host.state.appState.subagentModels,
      modelTiers: host.state.appState.modelTiers ?? {},
    });
  } catch (error) {
    host.showStatus(
      t('language.save_failed', { error: formatErrorMessage(error) }),
      host.state.theme.colors.error,
    );
    return;
  }

  const label = locale === 'zh' ? '中文' : 'English';
  host.showNotice(
    t('language.switched', { locale: label }),
    t('language.restart_hint'),
  );
}
