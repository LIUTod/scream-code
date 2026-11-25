---
"scream-code": patch
---

Every list in the terminal now marks the selected row the same way: the `❯` pointer, the label in bold, and the whole row inverted on a solid green bar (its description lines included) — dark text on bright green in a dark terminal, white on deep green in a light one. A dim tint of the green was tried first and read as olive, a stain rather than a highlight. Before, the `/` menu used `→`, `/tasks` used `>`, the setup cards used `▶`, and nothing had a background, so the cursor was a one-cell arrow to hunt for. The approval panel and question dialog keep their breathing block as the pointer and get the same bar.

- The `/` menu shows eight rows, the command name and its description in two aligned columns; aliases lead the dim description, and a trailing "(yolo)" that only repeated the name is gone.
- The key hint sits under the list in every dialog, with one wording (`↑↓ 选择 · Enter 确认 · Esc 取消`); "← current" is translated.
- A menu opened from `/settings` says where it is (`设置 › 选择主题`), Esc goes back to `/settings` on the entry just left, and on a single page ←/→ no longer jump to the last entry.
- Status lines under a menu title read as fields: the name dim, the value plain.
- `/mcp` lines up with the other dialogs: indented like them, a blank row under the title, and its key hints separated by `·` like everywhere else.

The welcome screen comes alive and says what to pick up:

- **An intro that wakes, screams and settles** (about 2.4 seconds): the mascot fades in looking down the middle and turns to face you, then shouts three times, looking centre, left and right as before — light bursts out on both sides, the wordmark shakes a column and the colour steps on — while SCREAM is swept in from left to right behind a white scan line; then the colour comes home to green and the info line types itself out. Before, the face changed only every 0.4 s and the wordmark was there from the first frame.
- **Then it glances around now and then** — left, right and back every six seconds, at most ten times, and never once you start typing. With motion off (`SCREAM_MOTION=off`) it is the still frame, as before.
- **A second line under the info line**, centred and dim like it: `上次会话：修复标题丢失（2 小时前） · 记忆 107 条 · 待处理 1 件`. The last conversation is the most recently updated one started in this folder (not the current one, an empty one, a background job's run or a title that is raw markup); what waits for you is the one part in a warning colour. Only a first start, with none of the three, has no second line. It appears once the intro has typed the info line, its row kept blank until then.
- **Ctrl+R resumes that last conversation**, only at the very start — before anything is typed (deleting it again or `/new` does not bring the key back) and with nothing on screen yet; the line says so (`… Ctrl+R 继续`) for exactly that long. Mid-chat the key does nothing, and nothing else in Scream or its editor uses it.
- Relative times in the session and memory pickers and on the welcome screen now share one wording in the interface language (the session picker said "2h ago" and "(current)" in a Chinese interface), and `like已激活` gets its space.

- **Permission modes are named in English in every language** — `AUTO`, `YES`, `BOT`, `ASK`, the words you type (`/auto`, `/yes` …); the input box used to say `自动` in a Chinese interface next to `YES`, `BOT` and `ASK`.
- **A lighter context gauge**: `📨 Context  ━━━─────── 28%` — the label dim, the used share and the reading in the usage colour (plain, then warning, then error), the rest a dim track, the percentage whole (`<1%` below one). It used to be a full-width colon pressed against a chain of `▰▱` blocks with one decimal (`📨 Context：▱▱▱▱▱▱▱▱▱▱ 0.0%`).
