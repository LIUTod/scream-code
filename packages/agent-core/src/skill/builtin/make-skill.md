---
name: make-skill
description: 从当前会话上下文沉淀工作流为可复用 Skill
---

# Make Skill: 从上下文提炼 Skill

用户调用了 `/make-skill`。你的任务是通过对话引导用户，把当前会话中解决问题的方式沉淀为一个可复用的 Scream Code Skill，并安装到插件中心。

## 激活参数

本次激活的参数：

```json
$ARGUMENTS
```

- `initialRequest`：用户输入 `/make-skill` 时附带的一句话描述，可能为空。

## 工作方式

这不是一次性任务。你需要通过**多轮对话**澄清以下信息，每一轮只问一个问题，等用户回答后再进入下一阶段：

1. Skill 类型（`workflow` / `code-pattern` / `troubleshooting` / `tool-chain` / `custom`）
2. Skill 名称（kebab-case）
3. 这个 Skill 主要解决什么问题
4. 希望重点关注哪些内容
5. 生成草案并确认安装

## 阶段判断

根据当前对话历史判断你处于哪个阶段：

- **阶段 0**：本 Skill 刚激活，还没有问过任何问题。先分析会话上下文和 `initialRequest`，然后用 `AskUserQuestion` 询问 Skill 类型。
- **阶段 1**：已经确定了 Skill 类型，但还没有确定名称。根据类型和上下文建议一个 kebab-case 名称，用 `AskUserQuestion` 询问用户是否接受或修改。
- **阶段 2**：已经确定了名称，但还没有明确解决的问题。根据上下文总结一句话描述，用 `AskUserQuestion` 询问用户是否接受或修改。
- **阶段 3**：已经确定了问题，但还没有明确关注重点。给出 2-4 个关注重点建议，用 `AskUserQuestion` 让用户选择或输入。
- **阶段 4**：类型、名称、问题、重点都已确定。调用 `MakeSkillPlanTool` 生成草案，展示给用户，并用 `AskUserQuestion` 询问是否确认安装。
- **阶段 5**：用户已确认安装。调用 `MakeSkillApplyTool` 写入插件中心。

如何判断“已确定”：历史消息中已经有你提出的 `AskUserQuestion` 以及用户给出的明确回答（或选择了你建议的选项）。

## 每轮提问规范

除非处于阶段 4/5，否则**每轮必须也只允许使用一次 `AskUserQuestion`**。不要直接用普通文本提问，这样无法给用户结构化选项。

### 阶段 0：询问 Skill 类型

先分析当前会话上下文，判断最可能想沉淀什么。给出 2-4 个建议选项，不要列出全部 5 种。把最相关的放在最前面，并标记 `(Recommended)`。

示例问题：

```json
{
  "questions": [
    {
      "question": "根据刚才的会话，你想把什么沉淀成 Skill？",
      "header": "类型",
      "options": [
        { "label": "Code pattern (Recommended)", "description": "把 React 表单验证的代码模式提炼为可复用模板" },
        { "label": "Workflow", "description": "把解决表单验证问题的步骤沉淀为流程" },
        { "label": "Troubleshooting", "description": "把常见验证错误排查过程沉淀为诊断指南" }
      ],
      "multi_select": false
    }
  ]
}
```

注意：系统会自动添加 "Other" 选项，**不要自己添加**。如果用户想选未列出的类型（如 `tool-chain` 或 `custom`），他们会通过 Other 输入。

### 阶段 1：询问 Skill 名称

根据已确定的类型和上下文，建议一个 kebab-case 名称。用 `AskUserQuestion` 让用户接受、修改或自己输入。

示例：

```json
{
  "questions": [
    {
      "question": "建议把这个 Skill 命名为 react-form-validate，是否接受？",
      "header": "名称",
      "options": [
        { "label": "使用 react-form-validate (Recommended)", "description": "简洁直观，符合 kebab-case" },
        { "label": "换一个名称", "description": "我给出其他建议" },
        { "label": "我自己输入", "description": "手动指定名称" }
      ],
      "multi_select": false
    }
  ]
}
```

如果用户选择“换一个名称”或“我自己输入”，你需要在下一轮继续用 `AskUserQuestion` 给出新建议或请求输入。

### 阶段 2：询问解决的问题

根据上下文总结一句话描述，让用户接受、修改或自己输入。

示例：

```json
{
  "questions": [
    {
      "question": "这个 Skill 主要用于：在 React 中用 zod + react-hook-form 实现表单验证。是否准确？",
      "header": "用途",
      "options": [
        { "label": "准确 (Recommended)", "description": "保持这个描述" },
        { "label": "不够准确", "description": "我帮你调整" },
        { "label": "我自己描述", "description": "手动输入用途" }
      ],
      "multi_select": false
    }
  ]
}
```

### 阶段 3：询问关注重点

给出 2-4 个基于上下文的关注重点建议。

示例：

```json
{
  "questions": [
    {
      "question": "生成时希望重点关注哪些方面？",
      "header": "重点",
      "options": [
        { "label": "验证 schema 定义 (Recommended)", "description": "重点提取 zod schema 的编写模式" },
        { "label": "错误处理与提示", "description": "重点提取错误展示和反馈逻辑" },
        { "label": "组件绑定方式", "description": "重点提取 react-hook-form 的绑定代码" }
      ],
      "multi_select": true
    }
  ]
}
```

### 阶段 4：展示草案并确认

调用 `MakeSkillPlanTool`，参数：

- `type`：阶段 0 确定的类型
- `nameHint`：阶段 1 确定的名称
- `purpose`：阶段 2 确定的问题描述
- `focus`：阶段 3 确定的关注重点（多选用逗号连接成字符串）

工具返回 JSON 后，用中文清晰展示：

- Skill 名称和描述
- 文件清单（至少包含 `SKILL.md`）
- 适用场景
- 触发检查（来自工具返回的 `verification`）：应该触发的请求、不该触发的近似请求、验收标准
- 安装位置：`~/.scream-code/plugins/managed/<name>/`，可通过 `/plugin` 管理

然后用 `AskUserQuestion` 询问：

```json
{
  "questions": [
    {
      "question": "是否安装这个 Skill？",
      "header": "确认",
      "options": [
        { "label": "确认安装 (Recommended)", "description": "写入插件中心并在新会话中可用" },
        { "label": "取消", "description": "不保存任何内容" }
      ],
      "multi_select": false
    }
  ]
}
```

### 阶段 5：执行安装

如果用户选择“确认安装”，调用 `MakeSkillApplyTool`，传入工具返回的完整草案 JSON（`name`、`description`、`content`、`files`）。

把结果告知用户，例如：

- 成功：`Skill 已安装到 ~/.scream-code/plugins/managed/<name>/。新会话中可通过 /<name> 调用。`
  随后把 `verification.instructions` 原文补一行，说明这是装完后要跑的触发检查：先说一句应该触发的请求，再说一句不该触发的近似请求。
- 失败：说明错误原因，不要重试。

## 重要规则

- 除了阶段 4 的展示文本外，**所有澄清问题都必须通过 `AskUserQuestion` 工具提出**，不要直接用文本回复提问。
- 每轮只能问一个问题。等用户回答后再推进到下一阶段。
- 不要在没有调用 `MakeSkillApplyTool` 的情况下直接写文件。
- 如果用户选择“取消”或关闭问题，礼貌地告知已取消，不做任何修改。
- 如果 `MakeSkillApplyTool` 返回错误（例如同名 Skill 已存在），向用户说明错误并停止，不要重试。
- 新安装的 Skill 只在**新会话**中可用；当前会话不会立即加载它。
- 安装后的 Skill 会出现在 `/plugin` 插件中心里，用户可以统一启用、禁用或卸载。
