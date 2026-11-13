---
"scream-code": minor
---

Phase-1 architecture optimizations

- LSP tool grows from 5 to 10 operations: hover, type definitions,
  implementations, file-scoped document symbols, and code actions (with
  an apply path that reuses the rename write-gate), all over the existing
  JSON-RPC client.
- Read gains an opportunistic declaration outline for large files (400+
  lines) when a language server is already running for that file type —
  it never cold-starts a server, and reads without one are byte-identical.
- Read/Grep now flag repeated identical fetches: after the second
  identical result a note lands in the system block, escalating after the
  fourth; the fingerprint includes the content anchor, so re-reads after
  an edit reset naturally, and micro-compaction forgetting an elided
  result exempts the allowed re-read.
- New opt-in `housekeepingModel` agent config runs compaction
  summarization on a cheaper model alias with a minimal prompt and no
  tool schemas; unset keeps the prefix-cache-sharing behavior unchanged.
