import type { MemoryMemoSummary } from '@scream-code/memory';

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
    '[用户从记忆备忘录中注入了以下历史记录]',
    '',
    `## 历史备忘录 #${memo.id}`,
    '',
    `- **用户需求**: ${memo.userNeed}`,
    `- **执行方案**: ${memo.approach || '(无)'}`,
    `- **完成结果**: ${memo.outcome}`,
    `- **踩坑记录**: ${memo.whatFailed && memo.whatFailed !== 'none' ? memo.whatFailed : '无'}`,
    `- **成功经验**: ${memo.whatWorked && memo.whatWorked !== 'none' ? memo.whatWorked : '无'}`,
    `- **来源会话**: ${sessionLabel}`,
    `- **记录时间**: ${date}`,
    '',
    '---',
    '请参考以上历史经验来处理当前问题。特别注意踩坑记录中的错误不要重犯。',
  ];

  return lines.join('\n');
}
