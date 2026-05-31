import { type MemoryMemo, createMemoryMemo } from './models.js';

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
  "problemsEncountered": "<issues found and how they were resolved, or 'none'>"
}
\`\`\`

Guidelines:
- Include any significant errors and their fixes in "problemsEncountered".
- Skip in-progress work unless it contains a landmark error+fix.
- Merge closely related sub-tasks into a single memo.
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

/** System prompt for exit-time extraction — instructs the LLM how to extract. */
export const EXIT_EXTRACTION_SYSTEM_PROMPT =
  'You are a memory extraction assistant. Your job is to scan a conversation transcript and identify completed task loops. Output ONLY in the specified JSON format. Do not call any tools.';

/** Build the user prompt for exit-time extraction, including a conversation sample. */
export function buildExitExtractionPrompt(
  sessionId: string,
  messageCount: number,
  sampleText: string,
): string {
  return `The following is a conversation transcript from session "${sessionId}" (${messageCount} messages total). Extract every **completed task loop** where:
- The user made a clear request or asked a specific question
- A solution or answer was provided
- The outcome is clear (success, partial success, blocked, or abandoned)

For each completed task loop found, output ONE structured memo block:

\`\`\`memory-memo
{
  "userRequirement": "<the user's request or question, one sentence>",
  "solution": "<the approach or solution, 2-4 sentences>",
  "completionStatus": "<done | partially done | blocked | abandoned>",
  "problemsEncountered": "<issues found and how they were resolved, or 'none'>"
}
\`\`\`

Guidelines:
- Include any significant errors and their fixes in "problemsEncountered".
- Skip in-progress work unless it contains a landmark error+fix.
- Merge closely related sub-tasks into a single memo.
- Use the exact field names and JSON format. Do NOT add extra fields.

If no completed task loops are found, output exactly:
\`\`\`memory-memo
{"none": true}
\`\`\`

--- CONVERSATION TRANSCRIPT (last 30 messages) ---

${sampleText}

--- END TRANSCRIPT ---`;
}
