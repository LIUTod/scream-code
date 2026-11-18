---
"scream-code": patch
---

`SCREAM_CODE_HOME` now moves all of your Scream data, and accepts the values people actually set.

- Your own skills (`skills/`) and instructions (`AGENTS.md`) live in the Scream home like config, sessions, memory and plugins. Before, they stayed in `~/.scream-code` whatever `SCREAM_CODE_HOME` said: moving the home left them behind, two homes shared them, and a clean home for CI or a container still read the machine's own. The skill center and the MCP skill installer write there too, and removing a skill works whatever the home folder is called. The generic `~/.agents/` folder, shared with other tools, stays in your OS home.
- If you had set `SCREAM_CODE_HOME` and still have skills or an `AGENTS.md` in `~/.scream-code`, the terminal UI says so at startup and where to move them; the hint stops once the new location exists.
- `SCREAM_CODE_HOME` is read the same way everywhere and on every platform: a blank value counts as unset (before, the app ignored it but the engine used the current directory), one pair of surrounding quotes is dropped (`set SCREAM_CODE_HOME="D:\Scream"` in cmd keeps them), `~/...` is expanded where no shell does it (Windows environment settings, launchd, systemd), and a relative path is made absolute.
