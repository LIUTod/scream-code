Execute a `{{ SHELL_NAME }}` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.

**Translate these to a dedicated tool instead:** `cat` / `head` / `tail` on a known path → `Read`; in-place `sed` / `awk` → `Edit`; `echo > file` / `cat <<EOF` → `Write`; `find` / recursive `ls` to locate files by name → `Glob` (a plain `ls <known-directory>` is fine); searching contents with `grep` / `rg` → `Grep`; talking to the user with `echo` / `printf` → just output text.

**Output:** stdout and stderr come back combined, truncated when too long; a failed command ends with a `Command failed with exit code: N` line.

If `run_in_background=true`, the command starts as a background task and this tool returns a task ID instead of waiting — give a short `description` when you do that. Background commands default to a {{ DEFAULT_BACKGROUND_TIMEOUT_S }}s timeout (`timeout` capped at {{ MAX_BACKGROUND_TIMEOUT_S }}s); set `disable_timeout=true` only when the task should run without one. You are automatically notified when the task completes: use `TaskOutput` for a non-blocking status snapshot (`block=true` to wait deliberately), `TaskStop` only to cancel, and point a human who wants to inspect background tasks at `/tasks` (an interactive panel).

**Guidelines for safety and security:**
- Each call runs in a fresh shell: variables, `cd` changes, and shell history are not preserved between calls.
- Never run an interactive command or one that may run forever. For possibly long-running foreground commands set `timeout` (in seconds): the default is {{ DEFAULT_TIMEOUT_S }}s and foreground commands allow up to {{ MAX_TIMEOUT_S }}s.
- Stay inside the working directory: avoid `..`, and avoid modifying files outside it unless explicitly instructed. Never run commands that require superuser privileges unless explicitly instructed.

**Guidelines for efficiency:**
{%- if SHELL_IS_POWERSHELL %}
- Chain with `;` to run commands sequentially. `&&` / `||` exist only from PowerShell 7 and are a parse error on Windows PowerShell 5.1, so write `; if ($?) { … }` when the next step must run only if the previous one succeeded.
- Filter and transform with pipelines (`Get-ChildItem | Where-Object …`); redirect with `>` / `>>`; quote paths containing spaces with single quotes.
- Read environment variables as `$env:NAME` (`$env:NAME = 'value'`), never `$NAME`; compose multi-step logic in a single call with `if` / `foreach` / `while` and `try` / `catch`.
{%- else %}
- For multiple related commands, chain them in one call with `&&`, e.g. `cd /path && ls -la`; use `;` to run sequentially regardless of success, and `||` for conditional execution.
- Use pipes (`|`) and redirections (`>`, `>>`) to chain input and output; quote paths containing spaces in double quotes; compose multi-step logic in a single call with `if` / `case` / `for` / `while`.
{%- endif %}
- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.

**Commands available:** the host's usual standard tools. When in doubt about a name, {% if SHELL_IS_POWERSHELL %}confirm it exists with `Get-Command <name> -ErrorAction SilentlyContinue` — several names are cmdlet aliases (`ls` → `Get-ChildItem`) and POSIX-only tools may be absent.{% else %}run `which <command>` first.{% endif %}
