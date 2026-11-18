/**
 * "Change history": what Scream changed about its own skills and memories
 * (the weekly self-review, approved follow-ups, rollbacks), from `/skills`
 * and `/memory history`. Pick a change to see what it touched and roll it
 * back. Plugins keep their own rollback in `/plugins`.
 */

import { t } from '@scream-code/config';
import { listEvolution, rollbackEvolution, showEvolutionChange, type EvolutionChange } from '@scream-code/scream-code-sdk';

import { getDataDir } from '#/utils/paths';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

function localTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function touched(change: EvolutionChange): string {
  const skills = new Set(change.files.filter((f) => f.startsWith('skills/')).map((f) => f.split('/')[1] ?? ''));
  const memories = change.files.filter((f) => f.startsWith('memory/')).length;
  const parts: string[] = [];
  if (skills.size > 0) parts.push(t('evolution.skills', { names: [...skills].join(', ') }));
  if (memories > 0) parts.push(t('evolution.memories', { count: String(memories) }));
  return parts.join(' · ');
}

function choose(
  host: SlashCommandHost,
  title: string,
  details: string[],
  options: ChoiceOption[],
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title,
        details,
        options,
        colors: host.state.theme.colors,
        onSelect: (value: string) => {
          resolve(value);
          host.restoreEditor();
        },
        onCancel: () => {
          resolve(undefined);
          host.restoreEditor();
        },
        onDispose: () => {
          resolve(undefined);
        },
      }),
    );
  });
}

export async function openEvolutionHistory(host: SlashCommandHost): Promise<void> {
  const home = getDataDir();
  const changes = await listEvolution(home);
  if (changes.length === 0) {
    host.showStatus(t('evolution.empty'), host.state.theme.colors.textDim);
    return;
  }
  const picked = await choose(
    host,
    t('evolution.title'),
    [t('evolution.hint')],
    changes.map((change) => ({
      value: change.sha,
      label: `${localTime(change.at)}  ${change.message}`,
      description: touched(change),
    })),
  );
  const change = changes.find((candidate) => candidate.sha === picked);
  if (change === undefined) return;
  let diff: string;
  try {
    diff = await showEvolutionChange(home, change.sha, 4_000);
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
    return;
  }
  const action = await choose(host, change.message, diff.split('\n').slice(0, 40), [
    { value: 'rollback', label: t('evolution.rollback'), tone: 'danger', description: touched(change) },
    { value: 'back', label: t('jobs.back') },
  ]);
  if (action === 'back') {
    await openEvolutionHistory(host);
    return;
  }
  if (action !== 'rollback') return;
  const result = await rollbackEvolution(home, change.sha);
  if (result.ok) host.showStatus(t('evolution.rolled_back', { message: change.message }));
  else host.showError(t('evolution.rollback_failed', { error: result.error }));
}
