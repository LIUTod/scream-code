# 发布流程（Release）

> 目标：10 个包版本永远同步（lockstep），CHANGELOG 自动生成，不再手动改 10 个 package.json。
> 本文档是给人看的操作手册；对应的自动化配置见 `.changeset/config.json` 与 `.github/workflows/release.yml`。

## 现状背景

- 仓库 10 个包中 **9 个是 private**（不发 npm），只有 `apps/scream-code`（name: `scream-code`）发布到 npm。
- 但**所有 10 个包的版本号必须保持同步**（0.13.x 全仓一致），这是发布纪律。
- 历史上发布一直走手动流程：逐个改 10 个 package.json（最近 14 次发布都是如此），tag 命名也不统一（`v0.10.0` / `0.11.2` 混用）。
- `.changeset/` 基础设施其实早已配置，但 `config.json` 的 `ignore` 列表把 6 个包排除在外，导致 changeset 无法维护全仓同步版本——这是发布被迫手动的原因之一。该问题已修复（`ignore: []` + 9 包 `fixed` 组）。

## 正确流程（每次发版）

```bash
# 1. 记录变更（交互式选择版本类型 patch/minor/major）
pnpm changeset add

# 2. 提交 changeset 文件
git add .changeset/ && git commit -m "chore: changeset for <feature>"

# 3. 推送到 main —— GitHub Actions 自动创建 "ci: release packages" PR
git push origin main
#    release.yml 的 changesets/action@v1 会运行 `pnpm run version:release`
#    （= changeset version），应用 fixed 组：9 个包版本同步 bump，
#    并为每个包生成 CHANGELOG.md。

# 4. 合并版本 PR（人工 review CHANGELOG 内容后 merge）
#    merge 会再次触发 push main → 若没有新的 pending changeset，
#    流程停留在"无变更可发布"状态。

# 5. 手动发布（当前 workflow 未配置自动 publish —— 见下方"自动发布"）
pnpm publish
```

## 版本同步规则（fixed 组）

`.changeset/config.json` 的 `fixed` 定义了 9 个包的同步组：

- `@scream-code/agent-core`、`@scream-code/config`、`@scream-code/evals`、
  `@scream-code/jian`、`@scream-code/knowledge`、`@scream-code/ltod`、
  `@scream-code/memory`、`@scream-code/scream-code-sdk`、`scream-code`

组内任意一个包 bump，组内全部同版本。**根 `package.json`（scream-code-monorepo）不在 workspace 列表内，changeset 不会动它**——发版时手动同步根的 `version` 字段（一行，其余 9 包全部自动）。

## 自动发布（可选，需要时再开）

当前 `release.yml` 的 `changesets/action@v1` 只配置了 `version`，**没有 `publish` 字段**，所以 CI 只生成版本 PR、从不发布。若想全自动发布，在 action 步骤加：

```yaml
        with:
          version: pnpm run version:release
          publish: pnpm publish
```

开启前确认 npm 的 `NPM_TOKEN` secret 已配置。**不启用也不影响流程**——手动 `pnpm publish` 即可。

## 发布前检查清单

- [ ] 工作区干净（无未提交的 package.json 版本修改）
- [ ] 本次变更已 `pnpm changeset add`（无变更可跳过，版本号不会动）
- [ ] 版本 PR 的 CHANGELOG 条目内容准确（`@changesets/changelog-github` 自动生成）
- [ ] 根 `package.json` 的 `version` 与 9 包同步
- [ ] tag 统一用 `vX.Y.Z` 前缀（历史 tag 有 `0.11.2` 无前缀，新 tag 一律带 `v`）

## 禁止

- ❌ 直接手动改 9 个包的 package.json 版本号（忽略 changeset 会打破版本同步，且 CHANGELOG 缺失）
- ❌ 无 `pnpm changeset add` 直接 bump（除非是紧急 hotfix 且事后补 changeset 文件）
