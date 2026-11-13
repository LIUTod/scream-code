---
"scream-code": minor
---

Edit-depth phase: line-range edits, stale-anchor recovery, and an edit benchmark

- New opt-in `replace_range` mode for Edit: replace or delete a line range
  (`start_line`/`end_line` + `new_string`, `old_string` omitted) against
  the anchor from the most recent Read. Line numbers refer to the model
  view of that read; the range must resolve within the file. The legacy
  str_replace path is byte-identical.
- Stale-anchor recovery for line-range edits: a session-scoped snapshot
  store remembers the content the model last read (and what our own last
  edit produced). When the anchor no longer matches but the target range
  still maps cleanly onto the current file through a line diff, the edit
  applies at the remapped range with an explicit warning. Recovery
  refuses when the external change lands inside the targeted region, and
  rolls back when a language server reports newly introduced errors.
  Without a snapshot, or in str_replace mode, the mismatch still hard-
  rejects exactly as before.
- New edit benchmark under packages/evals (`src/edit-bench/`): a seeded
  nine-class mutation library over five TypeScript fixtures with
  byte-exact expected-content verification, driven sequentially through
  the eval harness. It measures edit pass-rate and token cost and gates
  future format changes; model runs are an explicit manual step.
