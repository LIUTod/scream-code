---
"scream-code": patch
---

Fix activity block scroll regressions: black band and late last row

The collapsed activity block no longer pads its running state to a fixed
nine-row height with blank spacer rows — those rows rendered as the
terminal background, leaving a black band at the bottom of the viewport
for every running tool and making the newest steps look missing until the
next action filled a slot. Block height now follows content; a following
viewport re-seats on every layout frame, so the step swaps the padding
avoided cost nothing.

The TUI dependency moves to pi-tui 1.5.2, whose smooth scrolling now
lands a one-row wheel step in the same frame it walks (fraction 0.55,
snap threshold aligned with the rounding boundary at 0.5) and keeps the
fractional walk cursor across stacked wheel events — scrolling to the
bottom no longer hitches one or two frames before the last row shows.
