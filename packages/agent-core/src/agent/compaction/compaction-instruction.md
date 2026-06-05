
--- This message is a direct task, not part of the above conversation ---

You are now given a task to compact this conversation context according to specific priorities and output requirements.

Output text only. DO NOT CALL ANY TOOLS. Calling tools will be rejected and fails the task. You already have all the information you need in the conversation history. You have only one chance.

The goal of compaction is to keep essential code patterns, technical details, and architectural decisions for continuing development without losing context after the above messages are cleared work.

{{ customInstruction }}

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

## 记忆备忘录提取

在完成上述压缩摘要后，扫描被压缩的消息中是否存在**已完成的任务闭环**。任务闭环的判断标准：
- 用户提出了明确的需求或问题
- 给出了解决方案或回答
- 结果明确（成功、部分完成、受阻、或放弃）

对每个已完成的任务闭环，输出一个结构化记忆块。**必须用对话的主要语言书写**（中文对话用中文，英文对话用英文）：

```memory-memo
{
  "userRequirement": "<用户需求，一句话概括>",
  "solution": "<解决方案，2-4 句话>",
  "completionStatus": "<done | partially done | blocked | abandoned>",
  "problemsEncountered": "<遇到的问题及解决方式，无则填 'none'>",
  "category": "<user_preference | feedback | project_context | reference>"
}
```

**category 判断规则**：
- `user_preference`: 用户的行为偏好、工作习惯、个人风格或角色设定
- `feedback`: 从错误中学到的经验、"应该这样做而不是那样做"的反馈
- `project_context`: 项目架构、关键文件位置、进行中的重构或已知 bug
- `reference`: 外部系统的链接或指针（如项目名、Slack 频道、文档 URL）

注意：
- 在 problemsEncountered 中记录重要的错误信息和修复方法
- 跳过未完成的工作，除非其中包含有价值的错误修复经验
- 将紧密相关的子任务合并为一条记忆
- category 必须从上述四个值中选择一个，默认为 `project_context`
- 严格遵守字段名和 JSON 格式，不要添加额外字段

如果被压缩的消息中没有已完成的任务闭环，输出：
```memory-memo
{"none": true}
```
