Search file contents using regular expressions (powered by ripgrep).

Use Grep when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.
ALWAYS use Grep tool instead of running `grep` or `rg` from a shell - direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.

Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\{` to match a literal `{`.

Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default.
