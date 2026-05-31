When `run_in_background=true`, the subagent runs detached from this turn. The completion arrives in a later turn as a synthetic user-role message containing its result — you do not need to poll, sleep, or check on its progress. Continue with other work or respond to the user. Never fabricate or predict what the result will say.

For a background task, when `timeout` is omitted it falls back to the operator-configured background timeout, if one is set. If the operator has not configured a background timeout, an omitted `timeout` means the task runs with no time limit.
