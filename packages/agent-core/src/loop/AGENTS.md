# loop — Agent Turn Loop & Retry

## Responsibility
- Drive agent turns: `turn-step.ts` `runTurn` (dispatch step events → LLM call
  → tool execution → until the turn ends)
- Engine-level retry: `loop/retry.ts` `chatWithRetry` (default 10 attempts,
  abortable, covers 429/5xx/quota, honors Retry-After) — SDK retries are
  disabled (maxRetries:0), so this is the single retry entry point
- Event model: `loop/events.ts` (step.begin/end, content.part, tool.call/result,
  thinking.delta...)
- Auxiliary LLM calls (exit memory extraction / side questions / text
  generation / skill planning) go through `Agent.generateWithRetry`
  (3 attempts, also honors Retry-After)

## Dependencies
- Depends on: `Agent` (hub; context/records/tools/usage), `LtodLLM` (LLM
  calls), `loop/retry.ts`
- Depended on by: `Agent` (turn entry), `AgentServices.turn`

## Boundaries
- Does NOT: maintain session state (that is context/records); it only drives
  what this turn does
- **Retry discipline**: every provider call must go through `chatWithRetry`
  (main loop) or `generateWithRetry` (auxiliary) — never call `generate` raw
  (that loses retry/cancellation)
- Interrupt handling: `runOneTurn` end calls `closeAbandonedToolExchange` +
  `dropVacuousOpenMessages` (drops thinking-only empty messages)
- `turn.ended` emits after cleanup (RPC snapshot stays consistent with replay)

## Extension points
- New step type = add an event to `loop/events.ts` + dispatch in `turn-step` +
  handle in `context.appendLoopEvent`
- Adjust retry budget = `DEFAULT_MAX_RETRY_ATTEMPTS` in `loop/retry.ts`
