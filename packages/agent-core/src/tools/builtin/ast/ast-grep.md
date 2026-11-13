Search code by AST structure instead of text. Use it when the shape matters — "every call to `foo($A)`", "every `if ($COND)` without a block", "every exported function" — where regex or grep would match comments, strings, or formatting variants.

- `pattern`: ast-grep pattern syntax over source; `$NAME` matches one node, `$$$NAME` matches several. Use `$A`-style placeholders, not regex.
- `language`: typescript | tsx | javascript (inferred from the file extension when omitted).
- `path`: a file or a directory (defaults to the workspace root). Directories are walked recursively, skipping node_modules/.git/dist and similar build output.
- Results list one line per match as `path:line:column  matched-text` (first line of the match, truncated), capped at 100 matches; the header states the true total.
- Read-only. For structural rewrites use `ast_edit` (preview first, then apply).
