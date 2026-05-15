---
{"tags": ["version", "v0.2.2", "changelog", "features"], "created_at": "2026-05-15T14:06:41.907221", "updated_at": "2026-05-15T14:06:41.907221"}
---
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
