# compaction — Context Compaction (Full & Micro)

## Responsibility
- **FullCompaction**: compress the history into a summary when the context
  exceeds its budget (`applyCompaction` folds + writes `context.snapshot`);
  the worker retries (5 attempts, honors Retry-After)
- **MicroCompaction**: incremental folding (`micro_compaction.apply` advances a
  cutoff), deferred until a tool exchange closes
- Trigger strategy: `compaction/strategy.ts` (threshold + circuit breaker +
  watermarks + per-turn limit)
- Token basis: `tokensBefore/tokensAfter` = system prompt + tool schemas +
  messages (full-request basis, consistent with the measured anchors)

## Dependencies
- Depends on: `Agent` (hub; reads context.history, tools.loopTools,
  getRuntimeSystemPrompt)
- Depended on by: `Agent` (turn loop triggers it),
  `AgentServices.fullCompaction/microCompaction`

## Boundaries
- Does NOT: mutate the wire history (folding only affects memory and produces a
  summary record)
- Compaction request: reuse the real system prompt + sorted tools (hits the
  provider prefix cache) — do NOT substitute a custom prompt
- `apply_compaction` resets the micro cutoff and triggers
  `injection.onContextCompacted`
- Retries only apply to retryable errors (`isRetryableGenerateError`);
  non-retryable errors throw immediately

## Extension points
- New compaction strategy: implement the `CompactionStrategy` interface
  (full/micro are the current two)
- Tune triggering: adjust thresholds/circuit-breaker params in
  `compaction/strategy.ts`
