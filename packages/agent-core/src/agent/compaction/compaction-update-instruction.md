
--- This message is a direct task, not part of the above conversation ---

You are now given a task to UPDATE an existing compaction summary with new messages that came in after the last compaction.

A previous compaction summary already exists at the top of the conversation (the first assistant message). You must NOT discard it. Instead, merge the new information into the existing structure, keeping all previously captured state intact unless explicitly contradicted or resolved by the new messages.

Output text only. DO NOT CALL ANY TOOLS. Calling tools will be rejected and fails the task. You have only one chance.

{{ customInstruction }}

<!-- Previous Summary Reference -->

The first assistant message above is the PREVIOUS summary. Treat it as the source of truth for everything that happened before the new messages. Do not restate it verbatim — produce an updated, merged summary.

<!-- Memory Memo Extraction (PRIORITY — do not skip) -->

## 任务经验提取

AFTER completing the updated summary below, scan ONLY the new messages being compacted (not those already covered by the previous summary) for **completed task loops**. A task loop is "completed" when:
- The user made a clear request or asked a specific question
- You provided a solution or answer
- The outcome is clear (success, partial success, or failure)

For each completed task loop found, output a structured experience record **at the very end of your response**:

```memory-memo
{
  "userNeed": "<the user's need or goal, one sentence>",
  "approach": "<what was done — the approach taken, 2-4 sentences>",
  "outcome": "<final result, e.g. '完成', '部分完成', '失败: reason'>",
  "whatFailed": "<dead ends tried — things that didn't work, or 'none'>",
  "whatWorked": "<key actions that ultimately worked, or 'none'>",
  "tags": ["<tag1>", "<tag2>", "<tag3>"]
}
```

Guidelines:
- Record important failed attempts in "whatFailed" to help avoid repeating mistakes.
- Record key successful actions in "whatWorked" to help reuse effective approaches.
- Include 3-5 semantic "tags" summarizing the task domain, tech stack, or action type.
- Skip in-progress work unless it contains a valuable error+fix experience.
- Merge closely related sub-tasks into a single record.
- Use the exact field names and JSON format shown above.

If no completed task loops are found in the new compacted messages, output:
```memory-memo
{"none": true}
```

<!-- Update Rules -->

1. Preserve the section structure of the previous summary (Current Focus, Environment, Completed Tasks, Active Issues, Code State, Important Context, All User Messages).
2. Move newly-completed tasks from "Current Focus" / "Active Issues" into "Completed Tasks".
3. Update "Current Focus" to reflect what is being worked on RIGHT NOW.
4. Append new user messages to "All User Messages" — do not repeat those already captured.
5. Refresh "Code State" code snippets only if newer versions exist in the new messages.
6. Drop resolved issues from "Active Issues"; add newly-discovered ones.
7. Do not invent new information. If the new messages say nothing about a section, carry the previous content forward unchanged.

<!-- Required Output Structure -->

## Current Focus

[What we're working on now]

## Environment

- [Key setup/config points]
- ...

## Completed Tasks

- [Task]: [Brief outcome]
- ...

## Active Issues

- [Issue]: [Status/Next steps]
- ...

## Code State

### [Critical file name]

[Brief description of the file's purpose and current state]

```
[The latest version of critical code snippets in this file, <20 lines]
```

## Important Context

- [Any crucial information not covered above]
- ...

## All User Messages

- [Detailed non tool use user message]
- ...
