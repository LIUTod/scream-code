---
"scream-code": patch
---

Tool output is now budgeted in bytes at whole-line granularity. The old builder capped 50 000 UTF-16 code units, so Chinese output silently consumed three times the intended budget, an emoji could be cut in half at the boundary, and a long line could be sliced mid-character. The head only ever holds complete lines; the tail window may start mid-line but always on a character boundary; an over-long single line keeps its own cap and says so.

`read` stops promising something it could not do: the status block used to tell the model to re-read a long line with `n_lines=1`, which applied the same 2 KB cap. It now names the exact `bash sed -n '<line>p' … | head -c 65536` command.

Also bounded: `Glob` output (50 KiB, with an omitted-paths count), subagent summaries (50 KiB, with a resume pointer), bash full-output artifacts (`0o600` and exclusive create instead of world-readable `/tmp` files), and the startup catalog refresh (24-hour freshness window plus `If-None-Match`, so a `304` no longer reparses and rewrites the snapshot).
