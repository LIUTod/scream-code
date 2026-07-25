---
name: tool-prompt-optimization
description: Audit and trim tool prompt text that duplicates information already inferable from the tool's JSON schema, reducing system prompt token cost.
---

# Tool Prompt Optimization

A meta-skill for cutting system-prompt token waste: tool `description` text often
restates field names, types, and constraints that the Zod/JSON schema already
encodes. Use a probe to measure the overlap, then trim what the model can infer
from the schema alone.

## When to use

- System prompt token cost is high and tool descriptions are a meaningful share.
- A tool's `description` repeats field names or types already in its schema.
- Auditing tool definitions for redundancy before a release.

## How to audit

1. For each tool, lay the `description` text next to the Zod/JSON schema fields.
2. Flag sentences that merely restate field names, types, or constraints already
   encoded in the schema (e.g. "command is a string" when the schema already
   declares `z.string()`).
3. **Probe**: ask the model "Given only the schema (no description), which
   behaviors and constraints can you infer?" The intersection is pure redundancy.
4. Trim description text the model already infers from the schema alone.
5. **Keep** what the schema cannot express:
   - edge cases, gotchas, and ordering requirements
   - cross-tool interactions and precedence rules
   - safety-critical warnings and permission notes
   - examples that disambiguate ambiguous schema fields

## Rules

- Never remove safety-critical warnings or permission notes.
- Never remove examples that clarify ambiguous schema fields.
- Before deleting a sentence, run `git blame` to check whether it was added to
  fix a specific bug; if so, keep it (or confirm the bug is gone).
- Measure the before/after token count to confirm savings actually materialized.
- Prefer precise constraints over vague prose; if a constraint is enforceable in
  the schema (e.g. `.min(1)`), move it there instead of describing it in text.
