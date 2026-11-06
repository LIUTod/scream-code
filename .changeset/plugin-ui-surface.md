---
"scream-code": patch
---

Code plugins can now talk to the user instead of only adding tools. `context.ui` exposes three declarative primitives — `notify(level, message)`, `confirm({ title, body?, confirmLabel?, cancelLabel? })` and `progress(title)` with `update`/`done`/`fail` — all rendered by the host. A plugin therefore cannot wedge a session: `confirm` rides the same question channel the built-in ask tool uses and resolves `false` on a host that cannot ask, `notify` becomes a status message tagged `plugin:<level>`, and progress text is throttled to about five updates a second. Slash-command registration is not part of this change.
