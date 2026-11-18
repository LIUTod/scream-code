---
"scream-code": patch
---

Fixes found in a repository-wide cleanup.

- A subagent whose profile lists tools explicitly no longer receives main-agent-only tools (goal, memory, knowledge, image, plugin management, skill authoring, self-inspection, debugger). The eager tool registry always withheld them from subagents; the deferred tool groups now apply the same gate.
- The built-in `/make-skill` skill names its tools correctly (`MakeSkillPlan`, `MakeSkillApply`); it used to tell the model to call `MakeSkillPlanTool` / `MakeSkillApplyTool`, which do not exist.
- The npm package README shows the logo and sponsor images: publishing now rewrites `assets/` image paths to absolute URLs, as it already did for `docs/` links.
- The debug export (`/export-debug-zip`, `scream export`) records the session's first and last activity in its manifest: the scan looked for a session-level wire file that sessions do not have, so both fields were always empty.
- Removed unused dependencies (`marked`, `proper-lockfile`, `retry`, `zod-to-json-schema`, `ajv-formats`, the deprecated `@types/tar` stub), dead code and 61 unused interface strings.
