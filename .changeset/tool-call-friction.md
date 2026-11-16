---
"scream-code": patch
---

Fewer wasted tool calls. About 2% of tool calls in real sessions were rejected for reasons the runtime can absorb, and each one cost a whole model step.

- Tool arguments that are a complete JSON object followed by extra content (a duplicated object, stray markup) now run on the first object instead of failing with `Unexpected non-whitespace character after JSON`; the result tells the model the extra content was ignored so it can re-issue anything it meant. Truncated streams are still reconstructed as before.
- Common alternative argument spellings are accepted: `Read` takes `offset`/`limit`/`n`/`file_path`, `Edit` and `Write` take `file_path`, `Grep` takes `context`/`C`/`A`/`B`. Tools can declare their own through `ExecutableTool.normalizeArgs`.
- `Write` creates missing parent directories and says so in its result, instead of refusing. The directories are created only after the content has passed its other checks, so a write that is refused (for example for merge-conflict markers) leaves nothing behind.
- `Glob` accepts patterns that start with `**` and pure wildcards. They run under an 8-second budget and are reported as partial when a very large tree cuts the search short; anchored patterns are unchanged. The system prompt no longer says these are rejected.
- A call to an unknown tool is answered with the same tool under a different spelling (`Did you mean "Bash"?`) or the list of tools that exist.
- The TypeScript language server now looks for `typescript` in the workspace and its ancestors, next to the server itself, and in the running Node's global prefix. When it still cannot find it, the hint says so (`npm i -g typescript`) instead of telling people to install a language server they already have.
- A tool call cut off by the output-token limit now continues the turn (up to twice) with a result saying the output was too long and to split the work, instead of ending the turn with a "stream interrupted" message. Every truncation in the sampled sessions had 36–83K input tokens, so compaction no longer runs for it; truncated text replies are still compacted once per turn (previously once per session).
