---
name: custom-helper
description: 示例 Skill — 展示如何为 Scream 添加自定义技能。复制此文件夹并修改内容，即可创建你自己的 Skill。
---

# 自定义助手 Skill（示例）

这是一个 Skill 示例，演示了 Skill 文件的结构和写法。

## 什么是 Skill？

Skill 是 Scream 的**可插拔知识包**。你可以把常用任务、最佳实践、项目规范写成 Skill，放在 `.scream/skills/` 目录下，Scream 就会自动加载并在合适的时机使用它们。

## Skill 目录结构

```
.scream/skills/
├── my-skill/           # Skill 文件夹（名称即 Skill ID）
│   └── SKILL.md        # Skill 描述文件（必须）
└── another-skill/
    └── SKILL.md
```

## SKILL.md 格式

```markdown
---
name: skill-id          # Skill 唯一标识
description: 描述文字    # 触发条件说明，Scream 会根据描述决定何时调用
---

# Skill 标题

## 策略

1. 步骤一
2. 步骤二

## 相关文档

- 链接或引用
```

## 使用场景示例

- **代码审查规范**：定义团队的代码审查检查清单
- **项目架构说明**：描述项目模块关系和依赖规则
- **部署流程**：记录发布步骤和注意事项
- **API 规范**：定义接口命名和参数约定

## 复制创建新 Skill

```bash
cp -r .scream/skills/custom-helper .scream/skills/my-skill
# 然后编辑 .scream/skills/my-skill/SKILL.md
```

## 优先级

`.scream/skills/` 下的 Skill 优先级高于内置 Skill 和用户级 Skill。同名 Skill 以项目级为准。