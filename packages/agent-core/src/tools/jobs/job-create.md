Create a background task: standing work the background host runs by itself, whether or not a terminal is open — "every weekday at 9, check CI and tell me what broke", "tonight, upgrade the dependencies until the tests pass".

Use it for work that should happen without the person and outlive this session. For a reminder inside this conversation ("in 20 minutes, check the build"), use `CronCreate`: its fire lands here, a background task runs in a session of its own.

- Schedule: exactly one of `cron` (repeating, 5-field local time, e.g. `"3 9 * * 1-5"`), `in` (`"2h"`) or `at` (`"tomorrow 09:00"`), as for `CronCreate`. A task you create repeats at most every 15 minutes.
- `report_only: true` — look and report, change nothing (it runs in ask mode). Otherwise it acts in bot mode: reversible work runs; anything irreversible is refused and waits for the person's approval ("waiting for you"), while the run carries on with the rest.
- `done_when` — an outcome to reach ("all tests pass"). The run becomes a goal, judged by the independent grader, and reaching it ends the task.
- Each run starts in a fresh session with the notes the previous run left (its final answer), so write the prompt as the work itself, not as setup.
- At most 20 tasks are on at once; a task that fails 10 runs in a row is switched off and says so.
- It runs in the background host. When the result says the host is not running yet, tell the person it starts by itself the next time they open a terminal and then keeps running after the terminal closes; `/service` also starts it after a restart.

Report every task you create: what it does, when it first runs (the local `nextRunAt`), and that `/jobs` lists it.
