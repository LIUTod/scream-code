---
"@scream-code/cli": patch
---

Keep the running activity block at its settled height

While a turn runs, the collapsed activity block now reserves its full
collapsed budget with blank slots below the steps, so the block reaches its
settled height on the first step and every later step swaps a row's content
in place instead of pushing the transcript below it down. The running turn no
longer jostles the page once per step; the block settles to its real height
when the turn ends. Rendered on top of the pi-tui 1.5.1 scroll and repaint
work, streamed output, wheel scrolling and turn-end folds no longer jump the
screen.
