---
name: dream
description: 整理记忆库 — 合并重复、解决矛盾、清理过时条目
---

# Dream: 记忆合并整理

用户调用了 `/dream`。你要对记忆库进行一次完整的整理和清理。

## 前置检查

1. 先确定记忆文件位置：`<项目>/.scream-code/memory/entries.jsonl`
2. 如果文件不存在或为空，告知用户"记忆库为空，无需整理"并停止。

## 四阶段流程

### 阶段一：Orient（定向）

读取全部记忆（逐行 JSONL），了解现有记忆的全貌。统计：

- 总条数
- 按 category 分布（user_preference / feedback / project_context / reference）
- 按 completionStatus 分布（done / partially done / blocked / abandoned）
- 时间范围（最早 → 最新）

向用户报告概况。

### 阶段二：Gather（收集信号）

扫描所有记忆，找出以下信号：

**重复信号**（语义相同或高度相关）：
- 两条或多条记忆在说同一件事（如"修复登录页 token 刷新"出现了 3 次）
- 用你的理解判断，不只看关键词。比如"登录页 bug"和"token 过期问题"可能是同一件事

**矛盾信号**：
- 两条记忆给出相反的信息（如一条说"用方案 A"，另一条说"方案 A 不行要用方案 B"）
- 一条 done 而另一条 blocked 但描述的是同一件事

**过时信号**：
- 状态 done 且 >= 7 天前的记忆（已完成，无需保留详情）
- 状态 abandoned 且 >= 30 天前的记忆（放弃已久，可以清理）
- 内容指向已不存在的文件或旧架构

### 阶段三：Consolidate（合并方案）

对每组信号，产出合并建议：

**对于重复组**：
- 列出组内所有记忆 ID
- 给出合并后的一条新记忆（用最新的 userRequirement 为底，融合所有 solution）
- 选择最准确的状态（done > partially done > blocked > abandoned）
- 汇总所有 problemsEncountered

**对于矛盾组**：
- 列出冲突的记忆
- 给出你的判断：哪个是对的（或两者都保留并标记矛盾）
- 建议：保留更新的一条 + 在 solution 中注明"之前认为 X，后确认 Y"

**对于过时条目**：
- 建议直接删除（标注原因）

### 阶段四：Prune（裁剪确认）

输出完整的合并计划：

```
## Dream 整理计划

### 概况
- 当前共 X 条记忆
- 整理后预计 Y 条

### 重复合并（N 组）
**组 1: 修复登录 token 刷新**
- memo-abc123 (2026-05-01, done) — "登录页 token 过期需要手动刷新"
- memo-def456 (2026-05-10, done) — "登录 token 过期问题修复"
→ 合并为: "修复登录页 token 过期问题。方案: 在 axios 拦截器中添加自动 refresh 逻辑..."
  状态: done

### 矛盾解决（N 组）
**组 2: ...**

### 建议删除（N 条）
- memo-xyz789: "添加暗色模式" (done, 2026-04-01) — 已完成超过 2 个月

### 总结
- 合并: N 组 → 减少 X 条
- 删除: N 条
- 整理后: 共 Y 条记忆
```

用 AskUserQuestion 让用户选择：
- "执行整理" — 按计划执行
- "仅显示计划" — 不做修改
- "取消"

## 执行

如果用户确认"执行整理"：

1. 删除所有被合并的原记忆（用 Bash 读写 JSONL + 临时文件替换）
2. 为每个合并组追加一条新记忆（createMemoryMemo 字段）
3. 删除过时记忆
4. 更新 `.scream-code/dream-lock.json`：写入当前时间戳，sessionsSinceLastDream 归零
5. 报告结果："已删除 X 条，创建 Y 条合并记忆。当前共 Z 条记忆。记忆库整理完成。"

## 重要规则

- 不确定时保留原文，不要猜测删除
- 重复判断用语义理解，不要纯关键词匹配
- 矛盾组默认保留最新一条，旧的那条在 solution 中加注"已过时"
- 合并后的新记忆 category 取组内最常见的
- 操作前必须用户确认
- dream-lock.json 格式：`{ "version": 1, "state": { "lastDreamAt": "ISO时间", "sessionsSinceLastDream": 0 } }`
