## mem_062b4dda

**标签:** security, permission

PermissionEngine 默认规则：读取允许、写入询问、.env 文件拒绝

## mem_1059aa4e

**标签:** versioning

项目遵循 minor-bump-only 版本策略（Patch 始终为 0）

## mem_14b00994

**标签:** install, pypi, release

scream-code 尚未发布到 PyPI，目前只能通过源码安装

## mem_389520a1

**标签:** i18n, ui

汉化范围：审批面板、审批流程、错误消息、键盘提示

## mem_38971481

**标签:** docs, architecture

AGENTS.md 是项目架构文档，位于项目根目录

## mem_4e1bf2b8

**标签:** memory, storage

Memory System 采用 JSON frontmatter 格式存储标签和元数据

## mem_a2350c50

**标签:** docs, readme, user-experience

README.md 已重写，面向零基础、普通工作者、专业工程师三类用户

## mem_d08d6aca

**标签:** build, python

项目使用 uv + uv_build 构建，Python >= 3.12，行长度 100

## mem_d2dfd8ea

**标签:** version, v0.2.2, changelog, features

v0.2.2 版本迭代记录（历时两周）

已完成功能：
1. PermissionEngine — 通配符规则匹配，三级权限（allow/deny/ask），默认规则保护 .env/.ssh/.aws
2. Memory System — 双作用域持久记忆（project/global），JSON frontmatter 格式，DynamicInjectionProvider 注入
3. 汉化 — 审批面板、用户交互字符串、错误消息全部中文化
4. 首次运行向导 — 检测无配置自动进入 /config
5. /config 追加模式 — 多模型配置不覆盖，冲突确认对话框
6. /model 删除选项 — 清理无用模型及未引用 provider
7. /memory 命令 — add/list/search/delete
8. 文档更新 — README 面向三类用户，AGENTS.md 架构文档
9. Skill 系统 — .scream/skills/ 项目级 Skill，custom-helper 示例
10. 品牌清理 — 移除 scream-cli、Kosong、.claude/.codex 残留

待办/下个版本参考：
- 测试覆盖率补充
- 更多内置 Skill
- 性能优化
