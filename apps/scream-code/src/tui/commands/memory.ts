import type { MemoryMemoSummary } from '@scream-code/memory';

import type { SlashCommandHost } from './dispatch';

export async function handleMemoryCommand(host: SlashCommandHost, _args: string): Promise<void> {
  host.showMemoryPicker();
}

function statusLabel(status: string): string {
  switch (status) {
    case 'done': return '已完成';
    case 'partially done': return '部分完成';
    case 'blocked': return '受阻';
    case 'abandoned': return '已放弃';
    default: return status;
  }
}

export function formatMemoryMemoForInjection(memo: MemoryMemoSummary): string {
  const date = new Date(memo.recordedAt).toLocaleString('zh-CN');
  const sessionLabel =
    memo.sourceSessionTitle && memo.sourceSessionTitle.length > 0
      ? `${memo.sourceSessionTitle} (${memo.sourceSessionId.slice(0, 12)})`
      : memo.sourceSessionId.slice(0, 12);

  const lines = [
    '[用户从记忆备忘录中注入了以下历史记录]',
    '',
    `## 历史备忘录 #${memo.id}`,
    '',
    `- **原始需求**: ${memo.userRequirement}`,
    `- **解决方案**: ${memo.solution || '(无)'}`,
    `- **完成情况**: ${statusLabel(memo.completionStatus)}`,
    `- **遇到的问题**: ${memo.problemsEncountered && memo.problemsEncountered !== 'none' ? memo.problemsEncountered : '无'}`,
    `- **来源会话**: ${sessionLabel}`,
    `- **记录时间**: ${date}`,
    '',
    '---',
    '请参考以上历史经验来处理当前问题。',
  ];

  return lines.join('\n');
}
