---
"scream-code": minor
---

`/hl` no longer paints your messages as a bright yellow (or orange-red) block. A message now sits on a soft band — a light grey on a dark terminal, a soft dark grey on a light one, derived from the terminal's own background — only as tall as its text. The text and the `■` mark keep the user colour (yellow on dark themes, orange-red on light ones), so the mark no longer disappears into the block. The band is on by default; a choice made earlier with `/hl` is kept. A very long message (a pasted log) shows its first 12 and last 4 lines with the rest counted. Switching between dark and light now recolours messages already on screen.
