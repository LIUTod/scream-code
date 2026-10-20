---
name: dream
description: 整理记忆库 — 把经历归纳成可复用的规则
---

# 归纳记忆：把经历变成规则

用户调用了 `/dream`。你的任务不是清理垃圾，而是**把一次次的经历归纳成规则**。

记忆库是**全局**的，所有会话的备忘（memo）都在同一个 SQLite 数据库里（`<screamHomeDir>/memory/memos.sqlite`）。

- **备忘录（memo）**是原料：一次任务一条，人查、可注入。
- **巩固卡（digest）**是产品：一个主题一张，一句话结论 + 证据 + 时间戳。

`/dream` 的完整链路是：**先计划 → 用户确认 → 你亲自写卡 → 落卡**。任何一步都不能跳过。

## 第一步：取计划

调用 `MemoryConsolidatePlan`。返回 JSON 包含：

- `clusters`：主题簇。每簇有 `id`、`topicHint`（共同关键词）、`memoIds`、`sample`（至多 3 条原文摘要）、`recordedFrom` / `recordedTo`（**整簇**证据的最早/最晚时间）、`kindGuess`。
- `existingDigests`：已有的卡（`id` / `topic` / `kind`），用于判断是新建还是更新。
- `maintenance`：待维护数量（`expiredDigested` 宽限期已过的原料、`expiredEpisodic` 过期流水账、`overCap` 超上限、`dormant` 待休眠的卡）。
- `summary`：`totalMemos` / `clusters` / `estimatedLlmCalls`。

规则：

- `summary.totalMemos === 0` → 回复"记忆库为空，无需整理"并结束。
- `clusters` 为空 → 说明最近没有可归纳的重复经历，不要硬凑；但若 `maintenance` 里还有待处理项（`expiredDigested` / `expiredEpisodic` / `overCap` / `dormant`），仍应调用 `MemoryConsolidateApply` 并传 `{ "clusters": [] }`，让清理和休眠生效。
- `summary.estimatedLlmCalls > 30` → 先告诉用户这次归纳的规模，等确认后再继续。

## 第二步：展示计划（主题卡预览）

只展示**主题**，不要罗列原始 memo。每簇一行：

```
## Dream 归纳计划

### 概况
- 活跃备忘：X 条
- 可归纳主题：N 个
- 已有巩固卡：M 张

### 主题预览
1. <topicHint> — 证据 4 条 · 2026-08-02 ~ 2026-09-18 · 建议 kind: procedure
2. <topicHint> — 证据 2 条 · 2026-09-01 ~ 2026-09-05 · 建议 kind: pitfall

### 维护
- 宽限期已过、将删除的原料：A 条
- 过期流水账：B 条
- 超上限淘汰：C 条
- 转休眠的卡：D 张
```

时间范围必须取该簇的 `recordedFrom` / `recordedTo`（整簇范围），**不要**用 `sample[].recordedAt` 计算——sample 只有最新 3 条，会低估范围。格式 `YYYY-MM-DD`。说明："原料不会被立刻删除；归纳成功后会保留 14 天，可用卡片的 digest id 回滚。"

用 `AskUserQuestion` 让用户选择：

- `执行归纳` — 你写卡并落库
- `仅看计划` — 不做任何修改，直接结束
- `取消` — 结束

## 第三步：自己写卡（你是 LLM）

用户选择 `执行归纳` 后，**逐簇写 digest**。这是整个流程的核心，不要偷懒交给工具：

对每个簇：

1. 读该簇的 `sample`（原文摘要），判断这些经历共同指向什么规则。
2. 写 `topic`：一个稳定的主题名，同一个主题必须**每次写成同样的字符串**（否则会新建重复卡）。优先复用 `existingDigests` 里已有的 topic。
3. 写 `statement`：**一句话结论**，是能直接照着做的规则，不是任务复述。控制在 60 字以内。
4. 写 `kind`：
   - `fact` — 环境/代码库的客观事实
   - `procedure` — 可复用的做法或流程
   - `pitfall` — 踩过的坑、必须避免的做法
   - `preference` — 用户的偏好（通常走 `/like` 通道，这里只归档）
5. 写 `confidence`：`high`（多次验证/明确结果）、`medium`、`low`（单次、结果含糊）。
6. 写 `evidenceIds`：**只能**取该簇 `memoIds` 里的 id，且只放真正支撑这句话的那些。**绝不能编造 id，也不能引用别的簇的 id。**

无法从样本里归纳出可靠规则的簇：**直接跳过**，不要为了凑数写空话。

最终交给 `MemoryConsolidateApply` 的参数形如：

```json
{
  "clusters": [
    {
      "memoIds": ["memo-abc", "memo-def"],
      "digest": {
        "topic": "pnpm workspace 发布流程",
        "kind": "procedure",
        "statement": "发版前先跑 pnpm -r build，再用 changeset 生成版本号，最后统一推送。",
        "confidence": "high",
        "evidenceIds": ["memo-abc", "memo-def"]
      }
    }
  ]
}
```

- `memoIds`：该簇的全部 id（这些都会被折叠进这张卡）。
- `evidenceIds`：其中真正被引用到的 id，必须 ⊆ `memoIds`。越界会整批被拒绝，一卡不落。

## 第四步：执行并报告

调用 `MemoryConsolidateApply`，参数就是上面自写的 `{ clusters }`。

工具会做这些事（你不需要也不允许手动改库）：

- 同 topic 的卡：更新结论、`updatedAt`、`lastConfirmedAt`；旧结论进 `superseded`。结论没变则只刷新确认时间。
- 新 topic：新建巩固卡，`evidence_from/to` 取证据时间范围。
- 成功折叠的 memo：标为 `digested`，**保留 14 天**后才物理删除。
- 维护：删除宽限期已过的原料、清理 90 天未命中的流水账、超过 200 张的卡按"休眠优先 → 最久未命中 → 命中最少"淘汰、180 天未确认且从未命中的卡转 `dormant`。

拿到结果后，用四行数字报告：

```
新增卡 X / 更新卡 Y / 归档原料 Z / 淘汰卡 W
当前：备忘 N 条，巩固卡 M 张
```

其中 `created` → 新增卡，`updated` → 更新卡，`archived` → 归档原料，`evicted` → 淘汰卡。若 `deletedExpired` / `deletedStale` / `dormant` / `restored` 不为 0，另起一行说明。同时给出本次涉及的 digest id（可省略前缀），并注明：**14 天内可用 `MemoryConsolidateApply` 传 `undoDigestId` 回滚**。

## 附：回滚

用户说"撤销刚才的归纳"时，调用 `MemoryConsolidateApply`：

```json
{ "clusters": [], "undoDigestId": "digest-xxxx" }
```

工具会恢复该卡覆盖的 memo 并删除卡片；超过 14 天宽限期的原料已被物理删除，无法恢复，要如实告知。

## 硬性规则

- **只归档成功折叠的 memo**。没有产出卡的簇，其 memo 一条都不能动。
- **删除的顺序不能颠倒**：先提炼进卡，再标 `digested`，宽限期结束才物理删除。未折叠的流水账仍会在 **90 天未被命中**后过期（这是设计内的清理，不是归纳造成的）。
- **绝不编造 evidence id**，也不能跨簇引用。`evidenceIds ⊆ memoIds`，否则整批拒绝。
- **不写空话**。归纳不出规则就跳过，宁可少一张卡，不可多一条噪音。
- **不手改数据库**。不要用 Bash / 编辑工具直接动 `memos.sqlite` 或 `entries.jsonl`，一切通过 `MemoryConsolidateApply`。
- **操作前必须得到用户确认**，不能擅自执行。
