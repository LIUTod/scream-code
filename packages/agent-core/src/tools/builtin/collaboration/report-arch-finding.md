Report a finding about code that already exists. Use this tool for each issue found while diagnosing a codebase. Call it once for each issue.

Use this tool only when acting as an oracle agent. Do not use it when reviewing a patch for correctness bugs or when writing code.

Each finding must be evidence-backed, anchored to concrete files and symbols, and must satisfy every reporting criterion in your method. `fix` is required: a finding without a concrete replacement is a complaint, not a finding.

Tags name which of the four questions a finding answers, and what replaces it:
- `dead` — nothing reaches it. Replacement: delete.
- `dup` — same logic lives here twice. Replacement: keep one, delete the other.
- `wrong-layer` — dependency points the wrong way. Replacement: move or invert.
- `over-build` — abstraction with one consumer. Replacement: inline until a second appears.
- `under-build` — copy-pasted shape with no shared home. Replacement: extract once.
- `debt` — shortcut with a ceiling and no trigger. Replacement: name the ceiling, add the trigger.
- `portable` — platform or standard library already does it. Replacement: use the built-in.

Severity: P0 blocks the next change · P1 high friction · P2 medium friction · P3 cleanup.

Location is optional: omit `file_path` / `line_start` / `line_end` for module- or repo-level issues.

Example:
```json
{
  "title": "Delete the wrapper that only forwards",
  "problem": "SessionStore wraps Store and adds nothing but a rename. Every call site imports the wrapper, so a rename or a signature change has to be made twice.",
  "fix": "Inline the two forwarding methods into Store and point the call sites at it. Restore the wrapper when a second store type exists.",
  "tag": "over-build",
  "severity": "P2",
  "confidence": 0.8,
  "file_path": "src/session-store.ts",
  "line_start": 12,
  "line_end": 28
}
```
