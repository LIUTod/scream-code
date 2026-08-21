# compaction — Context Compaction (Full & Micro)

## Responsibility
- **FullCompaction**: compress the history into a summary when the context
  exceeds its budget (`applyCompaction` folds + writes `context.snapshot`);
  the worker retries (5 attempts, honors Retry-After via `computeDelayMs`)
- **MicroCompaction**: incremental folding (`micro_compaction.apply` advances a
  cutoff), deferred until a tool exchange closes
- Trigger strategy: `compaction/strategy.ts` (threshold + circuit breaker +
  watermarks + per-turn limit)
- Token basis: `tokensBefore/tokensAfter` = system prompt + tool schemas +
  messages (full-request basis, consistent with the measured anchors)
- After a successful compaction, scan the summary for a skill-candidate
  marker; emit `skill_candidate` so the UI can offer to save the reusable
  process (separate, isolated step after memory-memo extraction)

## Trigger thresholds (retuned for 256K–1M windows)
- `triggerRatio 0.85` — proactive compaction at 85% of the window
- `blockRatio 0.90` — block the turn at 90%, leaving headroom for the
  compaction request itself and output buffering on a 1M window
- Reserved-context rule (`shouldUseReservedContextSize`): when
  `usedSize + reservedSize(20K) >= maxSize`, treat as "compact now"
- Small-window models are no longer the design target

## Retention contract (what survives a compaction)
- Verbatim tail: 16 recent messages (8 user) with an absolute 20K-token
  budget, in addition to the relative ratio cap
- Mandatory `Key Decisions` and `Next Steps` sections in the compaction
  instruction so the summary preserves task continuity
- `readFiles`/`modifiedFiles` persist on `CompactionResult` and merge with the
  previous round's lists, so file context survives repeated compactions
  (lists are capped; stale file sections are stripped on iterative updates)

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

## Retry semantics
- Only retryable errors (`isRetryableGenerateError`) consume the retry budget
  (5 attempts) and back off with `computeDelayMs` (Retry-After preferred over
  fixed backoff); non-retryable errors throw immediately
- Context-overflow/truncation is a LOCAL shrink, not a server failure: each
  overflow shrinks the slice (`reduceCompactOnOverflow`) and retries
  immediately WITHOUT consuming the server-retry budget; the split point
  descends monotonically so it cannot loop
- At the minimum safe split, fall back to re-summarizing the input in halves
  and merging (`summarizeWithFallback`) instead of throwing the compaction
- A still-possible shrink is never discarded at the budget edge

## Reactive overflow recovery
- When the main request hits `APIContextOverflowError`, `handleOverflowError`
  starts a compaction and AWAITS it (via `block()`, bounded by the 120s block
  timeout) before the turn retries the request — recovery never races the
  un-compacted context against the provider
- User aborts propagate; a compaction that fails or times out surfaces the
  original overflow error
- Reactive recovery runs once per turn (`reactiveAttempted`)

## Worker identity (stale-run guard)
- The worker is owner-tagged; a worker whose abort signal was ignored by the
  provider and finishes late must NOT: cancel a newer compaction, clear its
  `compacting` record, consume its `compactionTimedOut` flag, mutate its
  circuit-breaker counter, apply its result to live context, or misread the
  newer history as a `/revoke`
- The `this.compacting !== owner` check runs BEFORE the history-change
  `/revoke` check on the success path

## Watermarks & model switches
- `lowWaterMark` = post-compaction effective tokens × 1.1; it gates the
  proactive trigger so compaction doesn't run twice back-to-back
- The watermark is measured against the model's context window: switching the
  model alias resets it (`resetLowWaterMark` on `modelAlias` change), so a
  stale mark from a large model cannot mask the overflow threshold of a
  smaller model

## Skill-candidate marker semantics
- The compaction instruction mandates at most one `[[skill-candidate:
  name|purpose|evidence]]` marker as the FINAL line of the response; `none`
  is an explicit "no candidate" verdict
- The last effective marker wins: a `none` marker CLEARS any candidate parsed
  earlier (e.g. stale markers carried over into an update summary), and a
  candidate parsed after a `none` still wins

## Dependencies (unchanged)
- Does NOT depend on the loop engine; the turn loop drives compaction via
  `fullCompaction.beforeStep/afterStep` hooks

## Extension points
- New compaction strategy: implement the `CompactionStrategy` interface
  (full/micro are the current two)
- Tune triggering: adjust thresholds/circuit-breaker params in
  `compaction/strategy.ts`
- End-to-end eval suite: `packages/evals` (isolated temp workspace, real
  model, rule-based judge; programmatic runner returns per-case results)
