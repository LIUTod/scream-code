---
"scream-code": minor
---

Scream keeps working when you close the terminal, and after a restart.

- **Background host** (`scream host`): one background scream process per Scream home. It continues work that stopped without finishing — a goal or a bot-mode run cut off by a crash, a shutdown or a power loss — and sessions you hand to it. It also serves the Feishu/WeChat channel when one is configured; `scream line` is now the same process (and works without a channel). `scream host start|stop|status|restart`.
- **Hand work to the background**: quitting with a goal running or a turn in progress asks whether to hand it to the background or stop it (Esc stays). When the terminal is closed by the system (SIGTERM), a goal or bot-mode run is handed over by itself. Opening a session the background host is working on offers to take it over.
- **Resident service** (`/service`, `scream service install|uninstall|status|restart|logs`): installs the background host as a per-user service — a LaunchAgent on macOS, a systemd user unit on Linux, a logon task on Windows — so it starts at login and restarts after a crash; no administrator rights. It is only installed when you choose it; setting up `/line` offers it once. While work runs on mains power it keeps the computer from idling into sleep (switch in `/service`; a MacBook still sleeps with its lid closed).
- **One process per session**: a session is open in one process at a time. Opening a session another terminal has open says where it is open instead of opening it twice (two writers could interleave its records), and deleting it is refused while it is open elsewhere.
- **Interrupted turns are mentioned**: opening a session whose last turn was cut off says so.
- After `scream` updates itself, a running background host is restarted onto the new version.
- The channel's log moved to `~/.scream-code/host/host.log`.
- Requests between scream processes no longer carry the home's control token: they carry a signature of the request (time-limited, single-use), so another user on the machine who binds a lock address first learns nothing. Clearing a stale lock file on macOS is guarded so two processes cannot both take the lock. On Linux and Windows the sleep inhibitor now ends when the host does, however it exits. The Windows launcher reads paths with non-ASCII characters correctly.
- Work the background picks up after a crash, a shutdown or a handover now keeps driving its goal instead of running one turn. A terminal taking a session back is not reported as work that stopped. Lock sockets on macOS live in the Scream home, so processes started from Terminal, SSH or the service always find each other.

