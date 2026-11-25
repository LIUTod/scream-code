# Background host and resident service

The background host (`scream host`) is a scream process without a window; there is one per Scream home. It does these things:

- **Continues work**: a goal (`/goal`) or bot-mode work cut off by a crash, a shutdown or a power loss is carried on, and so is a session a terminal handed over when it exited.
- **Chat channel**: when `/line` (Feishu or WeChat) is set up, it sends and receives the messages.
- **Hands back**: opening a session it is working on in a terminal lets you take it over; it stops its turn and gives you the session.
- **Background jobs**: runs the jobs in `/jobs` when they fall due (see below).
- **Waiting for you**: what unattended work could not decide alone (a refused action, a question) is kept until you answer: a note when a terminal opens, a count in the footer, a system notification; with Feishu or WeChat set up, a copy in the chat as well.

**Everything works without Feishu or WeChat.** The terminal comes first: opening it tells you what happened while you were away; the footer shows `◆ 1 waiting` when something needs you (or `◆ jobs not running` when the background is not up); the first sidebar panel (`Ctrl+X`) is Jobs — whether the background runs, what waits, and each job's last result and next run. A system notification pops up when something waits for you, a job fails, or handed-over work is done. A chat only adds a copy on your phone.

## Resident service (`/service`)

`/service` (shell: `scream service install`) installs the background host as a per-user system service. It then starts at login and restarts after a crash. No administrator rights are needed.

| System | How | When it starts |
|---|---|---|
| macOS | LaunchAgent (`~/Library/LaunchAgents`) | At login |
| Linux | systemd user unit (`~/.config/systemd/user`) | At boot, no login needed: install turns on lingering for you where that needs no password (root, or a desktop session). Otherwise at login, and `/service` tells you to run `sudo loginctl enable-linger $USER` |
| Windows | Logon task (hidden window) | At login |

The service runs a launcher script in `~/.scream-code/bin` that pins the node and scream paths and the `PATH` of the time, plus the CA, proxy and locale settings of the shell that wrote it (`NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY` and the like, `LANG`). Keys never go into it: a key lives in Scream's own credentials (`/config`). The launcher is repaired, never re-pointed: a scream start rewrites it only when the node or scream it runs is gone, and a checkout run from its sources never becomes the service. `scream service install` is how you point it at another install.

A service starts without your shell's environment, so a key exported in `~/.zshrc`, a company CA or a model set through `SCREAM_MODEL_*` variables is there in the terminal and missing in the background. Install therefore runs `scream host check` through the launcher, with an environment like the service's: it opens a session the way the host does (no MCP servers, no plugins), sends one tiny request, and deletes the session. `/service` shows the result, says what to do when it failed, and can run it again (a failed check is also retried every six hours from a terminal start). Once the check passed, a terminal starts the background through the service instead of as a process of its own, so a terminal's host and the service's host never compete for the lock.

A service host that still finds a terminal's host running waits for it to leave and takes over; `scream host stop` meanwhile leaves the background stopped. A host that dies three times within ten minutes is not restarted again: it says so (notification, `/service`, the log) and waits for the next login or `scream host start`.

It is installed only when you choose it: `/service`, `scream service install`, or the one offer made when `/line` is first set up. Turn it off with "turn off" in `/service` or `scream service uninstall`; your data stays.

`/service` also has "keep awake while work runs", on by default: while any scream process runs a turn on mains power, the host keeps the system from idling into sleep (`caffeinate` on macOS, `systemd-inhibit` on Linux, `SetThreadExecutionState` on Windows); on battery it does not. A laptop still sleeps with its lid closed, unless an external display is attached.

## Handing work over, taking it back

- Quitting a terminal (`/exit` works mid-turn) while a goal runs or a turn is unfinished asks whether to hand it to the background. If you do, the host continues it and is started when needed. Esc keeps you in.
- When nobody can be asked — the window closed, an SSH link dropped (SIGHUP), the system shutting down (SIGTERM) — work in progress (a goal, or the unfinished turn) is handed to the background, starting it first if needed, within a few seconds. `kill -9` or a power loss leaves no time for anything, but the "work in progress" record stays and the host continues it the next time it runs.
- Opening a session the host is working on offers **take over**, **just watch** or **back**. Taking over while the host is working carries the work on in the terminal (a goal is driven again) instead of leaving it where the host let go. Just watch does not take the session: it shows whether the host is running a turn, the goal, and the latest answer, and can be refreshed. A session another terminal has open cannot be taken; you are told where it is open.
- After a crash, shutdown or power loss, when the host carries interrupted work on it says so in the chat you used last.
- A session is open in one process at a time (session lock), so a terminal and the host never write to the same session at once.

## Background jobs (`/jobs`)

`/jobs` holds everything that runs without being asked: background jobs, and this session's reminders (formerly `/cron`, which still works).

- A job says four things: **what to do**, **when it starts** (once, or on a cron schedule), **whether it acts or only reports**, and **until when** (always, a date, or an outcome such as "the tests pass five times in a row").
- Each run gets a fresh session that stays out of `/sessions` and `-C`; its history is in `/jobs`. The newest 30 runs are kept per job. The last run's conclusion is passed to the next as its notes.
- A job that **acts** inside a git repository works in its own worktree (`~/.scream-code/worktrees/`) on a branch `scream/<job>/<date-time>`. Afterwards the host commits the changes to that branch and removes the worktree; your checkout is never touched. A run that changed nothing leaves no branch.
- A job that **only reports** cannot change anything.
- **No need to turn on `/service` first**: with jobs on, opening a terminal starts the background, which keeps running after the terminal closes, until the computer restarts. `/service` makes it start again after a restart.
- Jobs do not run while the background is down. When it runs again, runs missed in the last 24 hours are coalesced into one that knows how many it stands in for; older ones are skipped and noted in the brief and `scream report`. A run that fails for a reason that clears by itself (a timeout, the network down, the provider overloaded) is tried again 15 minutes later, twice at most, before it counts as a failure; `/jobs` shows it as `↻`. A job that fails ten runs in a row is switched off, and you are told.
- While the background host runs, a repeating task the agent schedules in a terminal session (every 15 minutes or less often) becomes a background job, so it keeps running after the terminal closes. One-shot reminders, more frequent ones, and tasks made in a chat stay in their session.
- Jobs the agent makes repeat at most every 15 minutes, and at most 20 jobs are on at once. Unattended (bot mode), the agent may create jobs and delete the ones it made; deleting one you set up waits for your approval.
- In the chat: `/jobs` lists jobs, `/brief` turns on the 08:30 daily brief, `/stop all` pauses all background work.
- **Daily brief**: every day at 08:30, a few sentences on what background work did, what failed and what waits for you, ending with the one thing you should look at. Offered only with Feishu or WeChat set up (asked once when the service is first turned on; `/brief` in the chat turns it on and off). Without a chat, the "while you were away" note in the terminal is your brief. `scream report` shows the same data at any time.

## Waiting for you

Unattended (bot mode), an irreversible action (such as `git push` or deleting files) is refused and a question has nobody to answer it. Instead of only being refused, they wait for you:

- In the terminal: a note when it opens, the top row of `/jobs`, a count in the footer and in `/service`, and a system notification (switch in `/service`). On macOS the notification comes from your terminal app while a Scream terminal is open (clicking it brings that window forward); with [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) installed (`brew install terminal-notifier`) it also shows when no terminal is open.
- With Feishu or WeChat set up, also in the chat: items from a chat session go back to that chat, others to the chat you last wrote from. With one item waiting, just reply `同意` (approve), `拒绝` (reject) or `以后都同意` (always approve). Or reply `/approve <id>` (add `session` to allow the same action for the rest of that session, `always` to allow it from now on), `/reject <id>`, `/mine <id>` (you do it yourself — a password, a second factor), or `/answer <id> <text>`; `/inbox` lists what is still waiting.
- The work does not wait meanwhile; it carries on with the rest. Once you approve, the host opens that session and lets **exactly that action** through once ("always" remembers it for unattended runs from then on), still through every permission check.
- An item nobody answers expires after 24 hours; what still waits and what expired go into the daily brief.
- "Always" remembers that one action; branches pushed by background jobs (`scream/<job>/<time>`) get a new name every run, so they count as one: once `git push origin scream/...` is always-approved, later pushes of such branches go through, while a push to `main` or a force push still asks.
- Results of jobs made in a terminal, and "done" for handed-over work, also go to the chat you used last (when one is set up).
- A background job with something waiting keeps its worktree until the item is settled or expires, then commits and cleans it up.

## Weekly self-review and change history

The weekly self-review is a built-in background job, and the only way scream improves itself. Turn it on with "turn on the weekly self-review" in `/jobs`, or when asked as the service is first turned on.

- It runs on Mondays at 08:00 and gets numbers only: how often each tool was called and failed over the week, the sessions with the most errors (ids only), and how often each skill was actually invoked over four weeks. It never reads conversations.
- It proposes at most three improvements per run — a new skill, a skill change, tidier memories, a plugin — each saying what, why, which sessions it came from and which friction it should reduce. Skills nobody invoked for four weeks are proposed for retirement.
- **By default it only proposes and changes nothing.** Open the job in `/jobs` to let it make small changes: new or edited skills are then made directly; deleting skills, writing memories and anything to do with plugins still wait for you. Enabling plugin code always asks.
- It works in the skills folder (`~/.scream-code/skills`); permission policies, budgets and `config.toml` are outside it, out of its reach. Skills cannot grant themselves tools.
- **Change history**: every change to skills and memories is recorded in `~/.scream-code/evolution` (a git repository; git must be installed). "Change history" at the bottom of `/skills`, or `/memory history`, shows what each change touched and rolls any one back. Plugins keep their own rollback in `/plugins`.
- Memories written unattended wait for you too, with the session they came from, and are saved only when you approve. What an acting job or continued work learned when it ends waits the same way and is used only once you choose "save"; report-only jobs (the brief, the self-review) keep nothing. These "save?" items are not pushed to the chat and raise no notification; they wait in `/jobs` and the terminal's note for 7 days.
- The self-review compares this week's error rates with the week before, to tell whether last week's changes helped.

## Daily token limit

`/service` can set a daily token limit (none by default) on unattended work only: jobs, continued work, and follow-ups of what waited for you. Once reached, no new run starts that day; work resumes the next day and you are told once.

## Commands

```
scream host [run|start|stop|status|restart|pause|check]   # run = in the foreground; pause stops all background work; check = can the background reach the model (through the service when one is installed)
scream service [install|uninstall|status|restart|logs]
scream report [--since 24h]   # what background work did: job runs, what waits, tokens today (no model call)
```

`stop` waits for a turn in progress to finish (up to 60 seconds) before exiting, on Windows too.

## Files

- `~/.scream-code/host/host.log`: the log, rotated to `host.log.1` past 5 MB
- `~/.scream-code/host/running/`: work in progress, one file per session, written when a turn starts and removed when it ends; a file left behind means the turn was cut off
- `~/.scream-code/host/settings.json`: `/service` settings (keep awake, daily token limit, notifications)
- `~/.scream-code/host/check.json`: the last `scream host check` run through the service's launcher
- `~/.scream-code/host/host-starts.json`: recent host starts, to stop a crash loop
- `~/.scream-code/host/stop-requested.json`: when a stop was last asked for
- `~/.scream-code/host/jobs.json`: background jobs
- `~/.scream-code/host/usage.json`: tokens unattended work spent today
- `~/.scream-code/host/inbox/`: what waits for you, one file per item
- `~/.scream-code/host/activity.jsonl`: what background work did (the "while you were away" note)
- `~/.scream-code/host/approved-actions.json`: actions you always-approved
- `~/.scream-code/worktrees/`: background jobs' worktrees
- `~/.scream-code/evolution/`: change history of skills and memories (a git repository)
- `~/.scream-code/run/control.token`: the secret requests between your scream processes are signed with (stop, hand back); readable by you only
