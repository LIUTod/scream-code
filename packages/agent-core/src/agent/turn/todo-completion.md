Before ending this turn, reconcile TodoList with the actual results of the current request. Some items are still pending or in_progress and no background task is running.

- Mark an item done only when its work and required verification really finished.
- If work cannot proceed without external input, use blocked and provide a concrete blocker. Do not leave finished or blocked work labelled in_progress.
- Keep genuinely unfinished work pending and explain it; do not mark it done or clear it just to dismiss this reminder. Do not revive unrelated work or exceed the user's scope.
- A final TodoList-only call is allowed when status synchronization is the only remaining action. Do not repeat completed work or successful checks merely to accompany it.
- Then give the user the final result and any remaining blockers. This is a one-time status reconciliation, not a request to loop until everything is green.
