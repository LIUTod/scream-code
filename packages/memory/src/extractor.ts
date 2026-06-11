import { type MemoryMemo, createMemoryMemo } from './models.js';

/**
 * Parse memory-memo blocks from LLM compaction output.
 */
export function parseMemoryMemos(text: string): MemoryMemo[] {
  const memos: MemoryMemo[] = [];

  // Match ```memory-memo ... ``` blocks (tolerate optional whitespace/newlines after header)
  const regex = /```memory-memo[\s\S]*?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1]?.trim();
    if (!jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      if (parsed['none'] === true) continue;

      const userNeed = typeof parsed['userNeed'] === 'string' ? parsed['userNeed'].trim() : '';
      if (userNeed.length === 0) {
        console.warn('[memory] Skipping memory-memo with empty userNeed:', jsonStr.slice(0, 200));
        continue;
      }

      memos.push(
        createMemoryMemo({
          userNeed,
          approach: typeof parsed['approach'] === 'string' ? parsed['approach'].trim() : '',
          outcome: typeof parsed['outcome'] === 'string' ? parsed['outcome'].trim() : '',
          whatFailed:
            typeof parsed['whatFailed'] === 'string' ? parsed['whatFailed'].trim() : 'none',
          whatWorked:
            typeof parsed['whatWorked'] === 'string' ? parsed['whatWorked'].trim() : 'none',
          extractionSource: 'compaction',
          sourceSessionId: '', // filled in by caller
          sourceSessionTitle: '', // filled in by caller
        }),
      );
    } catch (err) {
      console.warn('[memory] Malformed JSON in memory-memo block:', jsonStr.slice(0, 200), err);
    }
  }

  return memos;
}

/** System prompt for exit-time extraction — instructs the LLM how to extract. */
export const EXIT_EXTRACTION_SYSTEM_PROMPT =
  '你是一个任务经验提取助手。任务是从对话记录中识别已完成的任务闭环，提炼出任务经验记录。用对话的主要语言输出（中文对话用中文，英文对话用英文）。只输出指定的 JSON 格式，不要调用任何工具。';

/** Build the user prompt for exit-time extraction, including a conversation sample. */
export function buildExitExtractionPrompt(
  sessionId: string,
  messageCount: number,
  sampleText: string,
): string {
  return `以下是会话 "${sessionId}"（共 ${messageCount} 条消息）的对话记录。请提取其中所有**已完成的任务闭环**：

判断标准：
- 用户提出了明确的需求或问题
- 给出了解决方案或回答
- 结果明确（成功、部分完成、失败）

对每个已完成的任务闭环，输出一个结构化经验记录。**必须用对话的主要语言书写**：

\`\`\`memory-memo
{
  "userNeed": "<用户需求/目标，一句话概括>",
  "approach": "<执行方案，做了什么，2-4 句话>",
  "outcome": "<最终结果，如'完成'、'部分完成'、'失败：原因'>",
  "whatFailed": "<踩坑记录：试了但不行的路，无则填 'none'>",
  "whatWorked": "<成功经验：最终奏效的关键动作，无则填 'none'>"
}
\`\`\`

注意：
- whatFailed 记录重要的错误尝试，帮助未来避免重蹈覆辙
- whatWorked 记录最终成功的关键动作，帮助未来复用经验
- 跳过未完成的工作，除非其中包含有价值的踩坑经验
- 将紧密相关的子任务合并为一条记录
- 严格遵守字段名和 JSON 格式，不要添加额外字段

如果没有已完成的任务闭环，输出：
\`\`\`memory-memo
{"none": true}
\`\`\`

--- 对话记录（最近 30 条消息）---

${sampleText}

--- 对话记录结束 ---`;
}
