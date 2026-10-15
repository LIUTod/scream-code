You are running as a subagent. Use this tool to proactively contact your parent agent mid-run.

Three request types:

- `info` — ask for missing context, clarify an ambiguous instruction, or report a blocker while you keep working. The parent replies at its next turn boundary.
- `handoff` — ask the parent to route part of your work to a different capability (for example: "needs: independent verification of this logic"). Describe the capability you need (`needs`), never a specific agent, and say what a good reply looks like (`payload.expecting`) — the parent chooses the agent, approves, and routes the work with your artifacts.
- `escalate` — bump something to the human that you are not allowed to decide (a permission boundary, a contradiction in evidence, a scope question).

Include a `payload` with your work products (`artifacts`), proof (`evidence`), anything left unfinished (`missing`) and, for a handoff, the acceptance criteria you want back (`expecting`) — so the parent can route the work without you re-explaining everything.

Rate limit: up to 4 requests per turn; duplicate requests within a turn are merged. `accepted` means the request was delivered to the parent as a notification, which it sees at its next turn boundary. A request that is not `accepted` was never delivered: `parent_gone` or `not_active` means no reply can ever arrive — finish the work and report the open question in your result instead of waiting for one. Keep working while you wait for a reply; do not block on it.

**Never guess your way through a blocker.** If you are stuck or unsure, contact the parent instead of inventing an answer.
