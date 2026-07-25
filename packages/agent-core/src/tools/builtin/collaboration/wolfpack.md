Use WolfPack to spawn multiple subagents in parallel for batch operations.
This is ideal when processing many independent items (files, checks, searches)
that all use the same subagent type and follow a similar pattern.

Items must be independent - no subagent depends on another's output.
If items depend on each other, use separate Agent calls instead.

Choosing subagent_type for the batch:
- Batch code review, audit, or bug-finding across files -> reviewer
- Batch writing, reports, or long-form content -> writer
- Batch read-only exploration (find files, grep, understand modules) -> explore
- Batch verification (run build/test/lint per item) -> verify
- Batch deep debugging or architecture decisions -> oracle
- Batch planning or design work -> plan
- General engineering tasks with no specialised match -> coder (default)

Example: review source files for OWASP vulnerabilities by setting items to the file
paths, subagent_type to "reviewer", and prompt_template to the review instruction.
All items are processed in parallel.
