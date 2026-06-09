Use WolfPack to spawn multiple subagents in parallel for batch operations.
This is ideal when processing many independent items (files, checks, searches)
that all use the same subagent type and follow a similar pattern.

Input:
- description: Brief (3-5 word) task summary.
- subagent_type: Subagent profile name. Defaults to "coder".
- prompt_template: A prompt pattern where each item value is substituted in
  to produce a per-item prompt. See the parameter schema for placeholder syntax.
- items: Array of item strings. Each item gets its own subagent (max 20).

Items must be independent — no subagent depends on another's output.
If items depend on each other, use separate Agent calls instead.

Example: review three source files for OWASP vulnerabilities by setting
items to the file paths and prompt_template to the review instruction.
