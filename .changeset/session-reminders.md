---
"scream-code": patch
---

Your phone hears about sessions when they need you, not about everything.

- **Session reminders in the chat** (Feishu or WeChat): `✅「修复标题丢失」做完了 · scream-code · 用时 12 分钟`, `⏸「发布 0.21.3」在等你批准：git push origin main`, `❌「每日检查」没做完：…`. Each names the session, its project and what to do next; none carries the conversation. Several at once are one message; each is sent once.
- **Also your terminal's sessions, when you are away from it**: once the terminal has been out of focus for 3 minutes, a turn that finished, failed, or waits for an approval or an answer reaches the chat ("回到终端处理"). Come back first, answer it, or let a new turn start, and nothing is sent.
- **Choose in `/line` → 会话提醒**: background and away (default), background only, or off.
- **No more "started working on…" messages**: the chat hears when handed-over work is done, and whether a crash had cut it off.
- **Approvals pushed to the chat say which session they come from.**
- **A reminder that cannot reach WeChat says so** in the terminal's "while you were away" (WeChat needs a message from you first), with a system notification.
- **Background failures reach an open terminal** even where the background cannot show a system notification itself (a Mac without terminal-notifier, SSH).
- **The daily brief and the weekly self-review are no longer offered when you turn the service on**, and a brief with nothing to report sends nothing and costs no tokens. `/brief` in the chat and `/jobs` still turn them on.
