# @scream-code/memory

## 0.19.1

### Patch Changes

- [`164e04b`](https://github.com/LIUTod/scream-code/commit/164e04b413618ef27ca4e9c81f69d7a9c50d6259) - Memory stays a single entity: `memos`. `/dream` merges near-duplicate memos and asks the model to write a distilled conclusion for each merge group, stored on the replacement memo as its latest distillation (最新归纳); merged memos also keep their sources' notes and a traceable lineage (`distilledFrom`, `distilledAt`, `origin`). Distilled rules are never age-pruned as resolved/stale, and a group that holds a rule is skipped when the plan carries no new conclusion. Both `distilled` and `note` are persisted, editable via `MemoryEdit` or in place from `/memory`, shown in `/memory` and memo injection, and returned by `MemoryLookup`; both also count towards keyword relevance, and search falls back to a LIKE match when a term appears only in either field.

  Each memo now also records where it came from: `origin` (`session` = extracted experience, `dream` = /dream rule, `user` = conclusion rewritten by the user), `distilledAt` (when the conclusion was generated or last rewritten) and `distilledFrom` (a snapshot of the memos folded into it — `{id, title, at}`, title clipped to 80 chars, max 100 items, carried across consolidation generations so a rule distilled from other rules keeps its ancestry). Existing rows are migrated in place: `origin` is backfilled to `dream` for every memo that already carries a `distilled` conclusion.

  The `/memory` picker shows rule provenance on the card (归纳 / 人工归纳, the distilled time and the source count) and in the detail view (归纳于 + up to five source entries, then `+N`), and lets the user rewrite the conclusion in place with `e` → Enter; a rewrite sets `origin='user'` and a fresh `distilledAt`, while clearing the text drops back to an extracted memo. Because merging permanently deletes the original memos, the `/dream` preview must show any existing conclusion it overrides, and deleting a rule in `/memory` now warns that its originals are gone for good.
