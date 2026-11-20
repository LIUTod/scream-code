---
"scream-code": patch
---

YES mode asks before data leaves the machine only after a credential file was read. The hard floor added in 0.20.5 asked before any network call (a fetch, `curl`) once the session had read any file outside the working folder — reading another project or the docs next door was enough, so YES stopped for harmless lookups. Now only credential files count: `.env` files (in the workspace too), SSH and cloud keys, `~/.npmrc`, `~/.netrc`, `~/.pypirc`, `~/.git-credentials`, Docker and kube configs, the GitHub CLI login, Scream's own `config.toml`, and files named like a token or credential. Writes to git control files, shell startup files and autostart still ask in YES; AUTO still asks for nothing; ASK and BOT keep the broader check.
