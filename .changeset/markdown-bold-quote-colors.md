---
"scream-code": patch
---

Replies now colour their two plainest marks, with one palette across both modes: `**bold**` picks up a new `mdBold` token and keeps SGR bold — violet, bright on dark (`#C9A0FF`, 7.9:1) and deep on light (`#6C2B8C`, 8.9:1) — and block quotes move to `mdQuote` for both the text and the `│` border — pink, bright on dark (`#FF6B9D`, 6.2:1) and deep on light (`#C2185B`, 5.9:1). Only brightness is tuned per mode, so emphasis always reads as the heavier mark and the hues never change meaning. Headings keep their amber: the renderer builds them as `heading(bold(text))`, so the heading now drops inherited styling before recolouring — without that, the coloured `bold` repainted every heading and replies looked randomly tinted. Table headers stay weight-only, the cli-highlight `quote` token inside fences stays neutral, and plain prose still carries no colour at all: it follows the terminal's own foreground.
