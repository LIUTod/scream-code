import { t } from '@scream-code/config';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SlashCommandHost } from './dispatch';
import {
  getTuiConfigPath,
  loadTuiConfig,
  saveTuiConfig,
  type TuiConfig,
  type TuiLikePreferences,
} from '../config';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { getDataDir } from '#/utils/paths';

function promptTextInput(
  host: SlashCommandHost,
  title: string,
  opts?: { subtitle?: string; placeholder?: string; initialValue?: string; allowEmpty?: boolean },
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
      initialValue: opts?.initialValue,
      allowEmpty: opts?.allowEmpty,
      colors: host.state.theme.colors,
    },
  );
  host.mountEditorReplacement(dialog);
  return promise;
}

export function buildRoleAdditionalText(prefs: TuiLikePreferences): string {
  const lines: string[] = [
    '# USER PREFERENCES (set via /like — HIGHEST PRIORITY)',
    '',
    'The user has explicitly configured the following preferences via /like.',
    'These are direct user instructions and override default behavior. You MUST',
    'apply them in EVERY response. Violating them is equivalent to ignoring an',
    'explicit user request.',
  ];
  const items: string[] = [];
  if (prefs.nickname !== undefined && prefs.nickname.trim().length > 0) {
    items.push(`- Nickname: address the user as "${prefs.nickname.trim()}".`);
  }
  if (prefs.tone !== undefined && prefs.tone.trim().length > 0) {
    items.push(`- Tone: respond in ${prefs.tone.trim()} tone.`);
  }
  if (prefs.other !== undefined && prefs.other.trim().length > 0) {
    items.push(`- Other: ${prefs.other.trim()}`);
  }
  if (items.length === 0) return '';
  lines.push('', ...items, '', t('like.priority'));
  return lines.join('\n');
}

async function getUserPrefsPath(): Promise<string> {
  return join(getDataDir(), 'user-prefs.md');
}

async function persistLikePreferences(
  host: SlashCommandHost,
  prefs: TuiLikePreferences,
): Promise<void> {
  const configPath = getTuiConfigPath();
  const current = await loadTuiConfig(configPath);
  const updated: TuiConfig = {
    ...current,
    like: prefs,
  };
  await saveTuiConfig(updated, configPath);

  const roleAdditional = buildRoleAdditionalText(prefs);
  await writeFile(await getUserPrefsPath(), roleAdditional, 'utf-8');

  host.setAppState({ like: prefs });
}

export async function handleLikeCommand(host: SlashCommandHost): Promise<void> {
  const current = host.state.appState.like ?? {};

  const nickname = await promptTextInput(host, t('like.nickname'), {
    subtitle: t('like.nickname_hint'),
    placeholder: t('like.nickname_example'),
    initialValue: current.nickname,
    allowEmpty: true,
  });
  if (nickname === undefined) {
    host.showStatus(t('like.cancelled'), host.state.theme.colors.textDim);
    return;
  }

  const tone = await promptTextInput(host, t('like.tone'), {
    subtitle: t('like.tone_hint'),
    placeholder: t('like.tone_example'),
    initialValue: current.tone,
    allowEmpty: true,
  });
  if (tone === undefined) {
    host.showStatus(t('like.cancelled'), host.state.theme.colors.textDim);
    return;
  }

  const other = await promptTextInput(host, t('like.other'), {
    subtitle: t('like.other_hint'),
    placeholder: t('like.other_example'),
    initialValue: current.other,
    allowEmpty: true,
  });
  if (other === undefined) {
    host.showStatus(t('like.cancelled'), host.state.theme.colors.textDim);
    return;
  }

  const prefs: TuiLikePreferences = {
    nickname: nickname.trim().length > 0 ? nickname.trim() : undefined,
    tone: tone.trim().length > 0 ? tone.trim() : undefined,
    other: other.trim().length > 0 ? other.trim() : undefined,
  };

  await persistLikePreferences(host, prefs);
  host.showStatus(t('like.saved'), host.state.theme.colors.success);
}
