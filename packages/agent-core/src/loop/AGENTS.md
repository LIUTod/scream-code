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
- **Nested tool calls** (script sandbox): `executeNestedToolCall` re-enters the
  single-call pipeline (preflight → prepare/authorize hooks → approval →
  execute → finalize) with a `nested: true` step. Nested calls must stay out of:
  model-visible events (`dispatchToolCall` returns early), block ordinals, and
  the same-step dedup ledger (`ToolExecutionHookContext.nested` → the turn
  hooks skip it) — registering a nested call in the ledger deadlocks the parent
  when the model issued an identical call. `ExecutableToolContext.runNestedToolCall`
  exposes the runner; the re-entrancy guard filters the caller out of the tool
  list
- **Retry discipline**: every provider call must go through `chatWithRetry`
  (main loop) or `generateWithRetry` (auxiliary) — never call `generate` raw
  (that loses retry/cancellation)
- Interrupt handling: `runOneTurn` end calls `closeAbandonedToolExchange` +
  `dropVacuousOpenMessages` (drops thinking-only empty messages)
- Mid-batch steer interruption: `runToolCallBatch` polls the caller's
  `hasPendingSteer` (every `STEER_POLL_INTERVAL_MS`) and, on true, aborts the
  in-flight tools through a merged signal. The caller owns the lane: `Turn`
  trips it for user steers and for an explicit `interrupt: true` (the parent
  host's interject), never for background/cron steers or `interrupt: false`
  queue drains
- `turn.ended` emits after cleanup (RPC snapshot stays consistent with replay)

## Extension points
- New step type = add an event to `loop/events.ts` + dispatch in `turn-step` +
  handle in `context.appendLoopEvent`
- Adjust retry budget = `DEFAULT_MAX_RETRY_ATTEMPTS` in `loop/retry.ts`
