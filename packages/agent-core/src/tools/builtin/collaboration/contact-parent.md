You are running as a subagent. Use this tool to proactively contact your parent agent mid-run.

Three request types:

- `info` — ask for missing context, clarify an ambiguous instruction, or report a blocker while you keep working. The parent replies at its next turn boundary.
- `handoff` — ask the parent to pass part of your work to a different capability (for example: "needs: independent verification of this logic"). Describe the capability you need (`needs`), never a specific agent. The parent chooses the agent, approves, and routes the work with your artifacts.
- `escalate` — bump something to the human that you are not allowed to decide (a permission boundary, a contradiction in evidence, a scope question).

Include a `payload` with your work products (`artifacts`), proof (`evidence`), and anything left unfinished (`missing`) so the parent can route a handoff without you re-explaining everything.

Rate limit: up to 4 requests per turn; duplicate requests within a turn are merged. `accepted` means the request was delivered to the parent as a notification — the parent sees it at its next turn boundary (it may be delayed if the parent is mid-turn). Keep working while you wait; do not block on a reply. If the parent cannot help, it will tell you why via a message.

**Never guess your way through a blocker.** If you are stuck or unsure, contact the parent instead of inventing an answer.
