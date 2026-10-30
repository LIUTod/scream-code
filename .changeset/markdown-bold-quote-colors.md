---
"scream-code": patch
---

Replies now colour their two plainest marks. `**bold**` picks up a new `mdBold` token (dark `#FF6B9D` pink, light `#6C2B8C` deep violet) while keeping SGR bold, and block quotes move to `mdQuote` (dark `#B48CD8` violet, light `#C2185B` deep pink) for both the text and the `│` border. It is the same pair of hues with the roles swapped between modes, so each mode keeps one rule: emphasis is the heavier mark of the two — brighter on a dark background, deeper on a white one. The cli-highlight `quote` token inside fences stays neutral (`textMuted`), so file previews and code blocks are untouched, and plain prose still carries no colour at all: it follows the terminal's own foreground.
