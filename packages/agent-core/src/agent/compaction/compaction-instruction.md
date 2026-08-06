
--- This message is a direct task, not part of the above conversation ---

You are now given a task to compact this conversation context according to specific priorities and output requirements.

Output text only. DO NOT CALL ANY TOOLS. Calling tools will be rejected and fails the task. You already have all the information you need in the conversation history. You have only one chance.

The goal of compaction is to keep essential code patterns, technical details, and architectural decisions for continuing development without losing context after the above messages are cleared work.

{{ customInstruction }}

<!-- Memory Memo Extraction (PRIORITY — do not skip) -->

## 任务经验提取

AFTER completing the compaction summary below, scan the messages being compacted for **completed task loops**. A task loop is "completed" when:
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
  "tags": ["<tag1>", "<tag2>", "<tag3>"],
  "note": "<optional: a soft, AI-readable note/suggestion that makes the record easier for future turns to understand — e.g. '这类任务先查接口可用性再写代码'. Omit if none>"
}
```

Guidelines:
- Record important failed attempts in "whatFailed" to help avoid repeating mistakes.
- Record key successful actions in "whatWorked" to help reuse effective approaches.
- Include 3-5 semantic "tags" summarizing the task domain, tech stack, or action type (e.g. ["react", "auth", "部署"]).
- "note" is optional: a one-sentence advisory note that helps future AI understand/reuse the record faster. It is a soft suggestion, not a user-enforced rule.
- Skip in-progress work unless it contains a valuable error+fix experience.
- Merge closely related sub-tasks into a single record.
- Use the exact field names and JSON format shown above (no extra fields beyond "note").

If no completed task loops are found in the compacted messages, output:
```memory-memo
{"none": true}
```

<!-- Compression Priorities (in order) -->

1. **Current Task State**: What is being worked on RIGHT NOW
2. **Errors & Solutions**: All encountered errors and their resolutions
3. **Code Evolution**: Final working versions only (remove intermediate attempts)
4. **System Context**: Project structure, dependencies, environment setup
5. **Design Decisions**: Architectural choices and their rationale
6. **TODO Items**: Unfinished tasks and known issues

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

### [Critical file name]

- [Useful classes/methods/functions]: [Brief description/usage]
- ...

<!-- Omit non-critical code, intermediate attempts, and resolved errors -->

## Important Context

- [Any crucial information not covered above]
- ...

## All User Messages

- [Detailed non tool use user message]
- ...

## Skill candidates

Scan the compressed messages for reusable processes (project-specific build
steps, recurring debugging patterns, or tool workflows). If any is genuinely
worth capturing as a reusable skill, output at the very end, at most one:

[[skill-candidate: <name>|<one-line purpose>|<evidence>]]

Omit if none.
