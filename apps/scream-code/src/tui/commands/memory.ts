import type { MemoryMemoSummary } from '@scream-code/memory';

import { t } from '@scream-code/config';
import type { SlashCommandHost } from './dispatch';

export async function handleMemoryCommand(host: SlashCommandHost, _args: string): Promise<void> {
  host.showMemoryPicker();
}

export function formatMemoryMemoForInjection(memo: MemoryMemoSummary): string {
  const date = new Date(memo.recordedAt).toLocaleString('zh-CN');
  const sessionLabel =
    memo.sourceSessionTitle && memo.sourceSessionTitle.length > 0
      ? `${memo.sourceSessionTitle} (${memo.sourceSessionId.slice(0, 12)})`
      : memo.sourceSessionId.slice(0, 12);

  const lines = [
    t('memory.inject_prefix'),
    '',
    `## ${t('memory.history_title')} #${memo.id}`,
    '',
    `- **${t('memory.requirement')}**: ${memo.userNeed}`,
    `- **${t('memory.plan')}**: ${memo.approach || t('memory.plan_none')}`,
    `- **${t('memory.result')}**: ${memo.outcome}`,
    `- **${t('memory.pitfall')}**: ${memo.whatFailed && memo.whatFailed !== 'none' ? memo.whatFailed : t('memory.pitfall_none')}`,
    `- **${t('memory.experience')}**: ${memo.whatWorked && memo.whatWorked !== 'none' ? memo.whatWorked : t('memory.experience_none')}`,
    `- **${t('memory.source_session')}**: ${sessionLabel}`,
    `- **${t('memory.record_time')}**: ${date}`,
    '',
    '---',
    t('memory.inject_hint'),
  ];

  return lines.join('\n');
}
