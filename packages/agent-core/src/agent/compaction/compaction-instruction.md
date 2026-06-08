
--- This message is a direct task, not part of the above conversation ---

You are now given a task to compact this conversation context according to specific priorities and output requirements.

Output text only. DO NOT CALL ANY TOOLS. Calling tools will be rejected and fails the task. You already have all the information you need in the conversation history. You have only one chance.

The goal of compaction is to keep essential code patterns, technical details, and architectural decisions for continuing development without losing context after the above messages are cleared work.

{{ customInstruction }}

<!-- Memory Memo Extraction (PRIORITY — do not skip) -->

## 记忆备忘录提取

AFTER completing the compaction summary below, scan the messages being compacted for **completed task loops**. A task loop is "completed" when:
- The user made a clear request or asked a specific question
- You provided a solution or answer
- The outcome is clear (success, partial success, blocked, or abandoned)

For each completed task loop found, output a structured memo block **at the very end of your response**:

```memory-memo
{
  "userRequirement": "<the user's request or question, one sentence>",
  "solution": "<the approach or solution, 2-4 sentences>",
  "completionStatus": "<done | partially done | blocked | abandoned>",
  "problemsEncountered": "<issues found and how they were resolved, or 'none'>",
  "category": "<user_preference | feedback | project_context | reference>"
}
```

Guidelines:
- Include any significant errors and their fixes in "problemsEncountered".
- Skip in-progress work unless it contains a landmark error+fix.
- Merge closely related sub-tasks into a single memo.
- For category: user_preference = user habits/style/role, feedback = lessons learned,
  project_context = architecture/bugs/work-in-progress, reference = external pointer.
- Default to "project_context" when unsure.
- Use the exact field names and JSON format shown above.

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
