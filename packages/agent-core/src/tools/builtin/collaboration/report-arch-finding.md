Report a finding about code that already exists. Use this tool for each issue found while diagnosing a codebase — call it once per issue.

Use it only when acting as an oracle agent; not when reviewing a patch for correctness bugs or when writing code.

Each finding must be evidence-backed and anchored to concrete files or symbols, and must satisfy every reporting criterion in your method. `fix` is required: a finding without a concrete replacement is a complaint, not a finding.

Tags say which replacement the finding implies:
- `dead` — nothing reaches it → delete.
- `dup` — the same logic lives here twice → keep one, delete the other.
- `wrong-layer` — the dependency points the wrong way → move or invert it.
- `over-build` — an abstraction with one consumer → inline until a second appears.
- `under-build` — a copy-pasted shape with no shared home → extract once.
- `debt` — a shortcut with a ceiling and no trigger → name the ceiling, add the trigger.
- `portable` — the platform or standard library already does it → use the built-in.

Severity: P0 blocks the next change · P1 high friction · P2 medium friction · P3 cleanup.

Location is optional: omit `file_path` / `line_start` / `line_end` for module- or repo-level issues.
