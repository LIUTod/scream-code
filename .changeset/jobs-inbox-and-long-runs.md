---
"scream-code": minor
---

Background jobs, a "waiting for you" inbox, and unattended work you hear about.

- **`/jobs`** (replaces `/cron`, which still works): background jobs and this session's reminders in one panel. A job says what to do, when it starts (once, or on a cron schedule), whether it acts or only reports, and until when (always, a date, or an outcome such as "the tests pass five times in a row"). Each run gets a fresh session that stays out of `/sessions` and `-C`; its result shows in the job's run history and becomes the next run's notes. Missed times are skipped, ten failures in a row switch a job off and say so, and the agent can schedule jobs itself (`JobCreate`, at most every 15 minutes, 20 enabled).
- **Runs that act work in their own git worktree**, on a branch `scream/<job>/<date-time>`; the host commits what changed there and removes the worktree, so your checkout is never touched. A run that changed nothing leaves no branch.
- **Waiting for you**: in unattended (bot) mode an irreversible action or a question is no longer just refused — it is pushed to your chat and listed at the top of `/jobs`. Answer with `/approve <id>` (or `always`), `/reject`, `/mine` (you do it yourself) or `/answer <id> <text>`; the run carries on with other work meanwhile, and an approval lets exactly that action through once, still through every permission check. Items expire after 24 hours; what is still waiting or expired goes into the daily brief.
- **In the chat**: `/jobs`, `/brief` (a daily brief at 08:30), `/project` (switch this chat's project folder), `/stop all` (pause all background work).
- **`scream report [--since 24h]`**: what background work did — job runs, what waits for you, tokens today — read from what the host keeps, without asking a model. Turning the service on offers the daily brief once.
- **Missed runs**: runs missed in the last day while the background was not running are coalesced into one run that knows how many it stands in for; older ones are skipped and noted in the brief and `scream report`.
- **Repeating tasks outlive the terminal**: while the background host runs, a repeating task the agent schedules in a terminal session (every 15 minutes or less often) becomes a background job; one-shots, chat sessions and `in_session: true` stay in the conversation.
- **Allow for this session** (`/approve <id> session`), and **memories from unattended work wait for you**: what an acting job or continued work learned is saved only when you choose to.
- **Just watch**: opening a session the background is working on offers to watch it — whether a turn runs, its goal and its latest answer — without taking it over. Work picked up after a crash or power loss is announced in your chat.
- **Daily token limit** for unattended work, in `/service`; held runs resume the next day.
- The language-server hint now names the command that installs the missing server.
- The agent is told not to claim work is done without a tool result to show for it.
- **Terminal first, chat optional**: with jobs on, opening a terminal starts the background (it keeps running until the computer restarts; `/service` covers restarts). Opening a terminal says what happened while you were away; the footer shows `◆ 1 waiting` (or `◆ jobs not running`) only when something needs you; the sidebar's first panel is now Jobs (background state, what waits, each job's last result and next run) and the sidebar no longer has a Git panel (the footer shows the working tree); system notifications (macOS, Linux desktops, Windows 10+; switch in `/service`) when something waits, a job fails or handed-over work is done. With a chat channel, results of terminal-made jobs and finished handed-over work are pushed there too, and a plain "同意" / "拒绝" / "以后都同意" answers what was pushed. The daily brief is offered only with a chat channel.
- "Always allow" for a push of a background-job branch (`scream/<job>/<time>`) covers every later such branch.
- Memories to save are no longer pushed; they wait in `/jobs` and the away note for a week.
- In bot mode the agent may create tasks and delete the ones it made; deleting a task you set up waits for your approval.
