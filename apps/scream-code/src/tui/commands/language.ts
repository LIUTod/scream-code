import { t, setLocale, getLocale, type Locale } from '@scream-code/config';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { invalidateRotation } from '../components/chrome/footer';
import { saveTuiConfig } from '../config';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const LANGUAGE_OPTIONS: readonly ChoiceOption[] = [
  { value: 'zh', label: '中文 Chinese' },
  { value: 'en', label: 'English 英文' },
];

export function handleLanguageCommand(host: SlashCommandHost): void {
  const current = getLocale();
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: t('language.picker_title'),
      hint: t('language.picker_hint'),
      options: [...LANGUAGE_OPTIONS],
      currentValue: current,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyLanguageChoice(host, value as Locale);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyLanguageChoice(host: SlashCommandHost, locale: Locale): Promise<void> {
  if (locale === getLocale()) {
    host.showStatus(t('language.unchanged', { locale }));
    return;
  }

  try {
    setLocale(locale);
    invalidateRotation();
    host.state.appState.language = locale;
    await saveTuiConfig({
      theme: host.state.appState.theme,
      language: locale,
      editorCommand: host.state.appState.editorCommand,
      notifications: host.state.appState.notifications,
      like: host.state.appState.like,
      fusionPlan: host.state.appState.fusionPlan,
      subagentModels: host.state.appState.subagentModels,
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
