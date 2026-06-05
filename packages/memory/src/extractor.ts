import { type MemoryMemo, type MemoryCategory, createMemoryMemo } from './models.js';

/** Prompt injected into compaction to extract structured memos. */
export const MEMO_EXTRACTION_PROMPT = `
## Memory Memo Extraction

AFTER completing the compaction summary above, scan the messages being compacted
for **completed task loops**. A task loop is "completed" when:
- The user made a clear request or asked a specific question
- You provided a solution or answer
- The outcome is clear (success, partial success, blocked, or abandoned)

For each completed task loop found, output a structured memo block:

\`\`\`memory-memo
{
  "userRequirement": "<the user's request or question, one sentence>",
  "solution": "<the approach or solution, 2-4 sentences>",
  "completionStatus": "<done | partially done | blocked | abandoned>",
  "problemsEncountered": "<issues found and how they were resolved, or 'none'>",
  "category": "<user_preference | feedback | project_context | reference>"
}
\`\`\`

Guidelines:
- Include any significant errors and their fixes in "problemsEncountered".
- Skip in-progress work unless it contains a landmark error+fix.
- Merge closely related sub-tasks into a single memo.
- For category: user_preference = user habits/style/role, feedback = lessons learned,
  project_context = architecture/bugs/work-in-progress, reference = external pointer.
- Default to "project_context" when unsure.
- Use the exact field names and JSON format shown above.

If no completed task loops are found in the compacted messages, output:
\`\`\`memory-memo
{"none": true}
\`\`\`
`;

/** Parse memory-memo blocks from LLM compaction output. */
export function parseMemoryMemos(text: string): MemoryMemo[] {
  const memos: MemoryMemo[] = [];

  // Match ```memory-memo ... ``` blocks
  const regex = /```memory-memo\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1]?.trim();
    if (!jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      if (parsed['none'] === true) continue;

      const requirement = typeof parsed['userRequirement'] === 'string' ? parsed['userRequirement'].trim() : '';
      if (requirement.length === 0) continue;

      memos.push(
        createMemoryMemo({
          userRequirement: requirement,
          solution: typeof parsed['solution'] === 'string' ? parsed['solution'].trim() : '',
          completionStatus: normalizeCompletionStatus(parsed['completionStatus']),
          problemsEncountered:
            typeof parsed['problemsEncountered'] === 'string'
              ? parsed['problemsEncountered'].trim()
              : 'none',
          category: normalizeCategory(parsed['category']),
          extractionSource: 'compaction',
          sourceSessionId: '', // filled in by caller
          sourceSessionTitle: '', // filled in by caller
        }),
      );
    } catch {
      // Malformed JSON block — skip silently
    }
  }

  return memos;
}

function normalizeCompletionStatus(
  raw: unknown,
): MemoryMemo['completionStatus'] {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (s.startsWith('done') || s === 'completed' || s === 'complete') return 'done';
  if (s.startsWith('partial') || s === 'in progress') return 'partially done';
  if (s.startsWith('block') || s === 'stuck') return 'blocked';
  if (s.startsWith('abandon') || s === 'cancelled' || s === 'canceled') return 'abandoned';
  return 'done'; // default
}

function normalizeCategory(raw: unknown): MemoryCategory {
  const valid: MemoryCategory[] = [
    'user_preference',
    'feedback',
    'project_context',
    'reference',
  ];
  if (typeof raw === 'string' && valid.includes(raw as MemoryCategory)) {
    return raw as MemoryCategory;
  }
  return 'project_context'; // default for backward compat
}

/** System prompt for exit-time extraction — instructs the LLM how to extract. */
export const EXIT_EXTRACTION_SYSTEM_PROMPT =
  '你是一个记忆提取助手。任务是从对话记录中识别已完成的任务闭环。用对话的主要语言输出（中文对话用中文，英文对话用英文）。只输出指定的 JSON 格式，不要调用任何工具。';

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
- 结果明确（成功、部分完成、受阻、或放弃）

对每个已完成的任务闭环，输出一个结构化记忆块。**必须用对话的主要语言书写**：

\`\`\`memory-memo
{
  "userRequirement": "<用户需求，一句话概括>",
  "solution": "<解决方案，2-4 句话>",
  "completionStatus": "<done | partially done | blocked | abandoned>",
  "problemsEncountered": "<遇到的问题及解决方式，无则填 'none'>",
  "category": "<user_preference | feedback | project_context | reference>"
}
\`\`\`

注意：
- 在 problemsEncountered 中记录重要的错误和修复方法
- 跳过未完成的工作，除非其中包含有价值的错误修复经验
- 将紧密相关的子任务合并为一条记忆
- category 从四个值中选一个，不确定时用 project_context
- 严格遵守字段名和 JSON 格式，不要添加额外字段

如果没有已完成的任务闭环，输出：
\`\`\`memory-memo
{"none": true}
\`\`\`

--- 对话记录（最近 30 条消息）---

${sampleText}

--- 对话记录结束 ---`;
}
