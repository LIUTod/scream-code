Rewrite code by AST structure: every match of `pattern` becomes `rewrite`. This is the tool for mechanical refactors that string replacement cannot do safely (adding a wrapper around every call, swapping API shapes, normalizing patterns).

Modes:
- `preview` (default): returns the replacement diff and count. Nothing is written. Always preview first.
- `apply`: writes the file. Requires `expected_matches` equal to the count the preview returned — if the file changed since the preview, the count no longer matches and the apply is refused rather than guessed. The write goes through the same safety pipeline as Edit: conflict-marker guard, per-file mutation lock, and a language-server diagnostic notice afterwards.

`rewrite` uses `$NAME` placeholders taken from the matched nodes; `$$$NAME` multi-capture expansion is not supported — split the edit or use Edit for those cases. Preview output shows up to 40 diff lines; the count in the header is authoritative.
