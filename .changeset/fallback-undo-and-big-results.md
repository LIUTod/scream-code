---
"scream-code": patch
---

Recovery and undo.

- Fallback model: in `/model`, Tab on a model makes it the fallback (its row is tagged 备用; Tab again clears it). When the main model keeps failing — three transient failures in a row, a rejected key, a model that no longer exists, or an exhausted quota — the turn switches to the fallback once, says so in the footer, and stays on it for the rest of the turn; the next turn starts on the main model again. Usage is billed to the model that answered.
- `/revoke` can take the code back too: when the turns being undone changed files with Edit, Write or AstEdit, it asks whether to undo the conversation and the code, or the conversation only, and lists the files. A file changed since by hand or by a shell command is kept as it is and named. The history is kept in the session directory, so it works after a restart.
- Long MCP results are no longer cut off: past 20K characters the whole result is saved to a file and the model gets a preview and the path.
- `FetchURL` takes an optional question: a helper model reads a long page and only its answer enters the context. A long page without a question comes back as its start plus the path of the saved page.
