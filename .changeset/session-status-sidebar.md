---
"scream-code": patch
---

The sidebar (`Ctrl+X`, `/sidebar`) is now the session status: one borderless column that watches how Scream is used and what it is doing.

- A heatmap of your daily token use: weeks across, Monday, Wednesday and Friday down, the months along the top, five shades by how much each day was used. A day is two or three columns wide with a column of air between days, so the picture is not a squeezed sliver and every day can be told from the next; a long history shows its recent weeks. Days and months are written in the interface language (`周一`, `8月` in Chinese; `Mon`, `Aug` in English). Under it: today, 7 days, 30 days, cache hit, active days and the current streak, counted the way `/usage` counts (cache reads included).
- The numbers are counted from your own session logs and kept in `usage-ledger.json` in the data directory. The first time the sidebar opens, the history is counted in the background (newest first, with a percentage shown); after that only what changed is read, today is counted live, and days already counted stay even if the logs are deleted. Two terminals open at once agree, because a day is recounted, never added to.
- A live block: the model's first-token time with a trend of the last ten requests, one row for the next background job (only while there are jobs; a warning when something waits or the background is down), the session's numbers once it has made a request, only the agents that are running, and the goal on two rows.
- The share of each model over the last 30 days, top three and the rest. A model is named by its id, so one reached through two aliases, re-added after a delete, or moved to another provider counts as one; names that would collide when cut keep their end, where versions are.
- The width follows the terminal (about 40%, 40 to 60 columns; 60 draws a whole year) unless you fix it with `/sidebar width <n>`; `/sidebar width auto` hands it back. The thin line on its left is the only border.
- When the terminal is too short the mouse wheel scrolls the sidebar (and dragging its scrollbar); the transcript stays put, and the keyboard keeps scrolling the transcript.
- The slash command reads "Session status: press Ctrl+X or type this slash command", and `/hotkeys` lists Ctrl+X as open/close session status.
- Removed: the separate Jobs, Session, Agent, Goal and network panels, `/sidebar next`, `/sidebar prev` and `/sidebar panel`, and the network probe, which sent a request to a handful of public sites every 30 seconds while the sidebar was open.
