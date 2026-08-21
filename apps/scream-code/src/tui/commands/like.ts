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
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
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
  const doNot = prefs?.doNot?.trim();
  const hasToolPriority = prefs?.toolPriority !== undefined && prefs.toolPriority !== 'default';
  if (items.length === 0 && (doNot === undefined || doNot.length === 0) && !hasToolPriority) return '';
  lines.push('', ...items);
  if (doNot !== undefined && doNot.length > 0) {
    lines.push(
      '',
      '## Do NOT (explicit prohibitions — NEVER do these)',
      doNot,
    );
  }
  if (hasToolPriority) {
    lines.push(
      '',
      '## Tool priority (set via /like — HIGHEST PRIORITY)',
      prefs.toolPriority === 'skill'
        ? 'For every user request: (1) first analyze the intent, (2) then identify whether any installed skill matches THIS request, (3) if one matches, invoke the Skill tool with it as your FIRST action — before MCP tools or doing it yourself, (4) if none matches, proceed with MCP tools or solve it yourself. Consult the skill list shown in the Skill tool description whenever you are unsure what is installed.'
        : 'For every user request: (1) first analyze the intent, (2) then identify whether any available MCP tool matches THIS request, (3) if one matches, use it as your FIRST action — before the Skill tool or doing it yourself, (4) if none matches, proceed with the Skill tool or solve it yourself.',
    );
  }
  lines.push('', t('like.priority'));
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
  try {
    await saveTuiConfig(updated, configPath);
    await writeFile(await getUserPrefsPath(), buildRoleAdditionalText(prefs), 'utf-8');
  } catch (error) {
    // Roll BOTH stores back to their previous state so they never diverge.
    // writeFile is non-atomic, so a partial failure could otherwise leave a
    // truncated user-prefs.md while tui.toml carries the old value.
    try {
      await saveTuiConfig(current, configPath);
    } catch {
      // Best-effort rollback; the original error below is the real signal.
    }
    try {
      await writeFile(
        await getUserPrefsPath(),
        buildRoleAdditionalText(current.like ?? {}),
        'utf-8',
      );
    } catch {
      // Best-effort rollback; the original error below is the real signal.
    }
    throw error;
  }
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

  const doNot = await promptTextInput(host, t('like.do_not'), {
    subtitle: t('like.do_not_hint'),
    placeholder: t('like.do_not_example'),
    initialValue: current.doNot,
    allowEmpty: true,
  });
  if (doNot === undefined) {
    host.showStatus(t('like.cancelled'), host.state.theme.colors.textDim);
    return;
  }

  // Step 5: preferred tool dispatch priority (skill-first / mcp-first / default).
  // Reuses the choice picker; the selection is persisted with the other prefs.
  const toolPriority = await promptToolPriority(host, current.toolPriority);
  if (toolPriority === undefined) {
    host.showStatus(t('like.cancelled'), host.state.theme.colors.textDim);
    return;
  }

  const prefs: TuiLikePreferences = {
    nickname: nickname.trim().length > 0 ? nickname.trim() : undefined,
    tone: tone.trim().length > 0 ? tone.trim() : undefined,
    other: other.trim().length > 0 ? other.trim() : undefined,
    doNot: doNot.trim().length > 0 ? doNot.trim() : undefined,
    toolPriority,
  };

  await persistLikePreferences(host, prefs);
  host.showStatus(t('like.saved'), host.state.theme.colors.success);
}

function promptToolPriority(
  host: SlashCommandHost,
  current: TuiLikePreferences['toolPriority'],
): Promise<'default' | 'skill' | 'mcp' | undefined> {
  const { promise, resolve } = Promise.withResolvers<'default' | 'skill' | 'mcp' | undefined>();
  const options = [
    { value: 'default', label: t('like.tool_priority_default') },
    { value: 'skill', label: t('like.tool_priority_skill') },
    { value: 'mcp', label: t('like.tool_priority_mcp') },
  ];
  const picker = new ChoicePickerComponent({
    title: t('like.tool_priority_title'),
    hint: t('like.tool_priority_hint'),
    options,
    currentValue: current ?? 'default',
    colors: host.state.theme.colors,
    onSelect: (value) => {
      host.restoreEditor();
      resolve(value as 'default' | 'skill' | 'mcp');
    },
    onCancel: () => {
      host.restoreEditor();
      resolve(undefined);
    },
  });
  host.mountEditorReplacement(picker);
  return promise;
}
