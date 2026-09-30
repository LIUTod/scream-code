# context — Message History, Projection & Token Gauge

## Responsibility
- Maintain session message history (`history`), in-flight steps (`openSteps`),
  and the token gauge (`tokenCount` + covered count)
- Assemble messages sent to the LLM: `messagesForLLM` (projection +
  prefix-cache stability observation)
- **Message identity**: `ContextMessage.id` (`m<n>`) is assigned on first
  insert (`appendMessage` / `pushHistory` / compaction summary) and restored
  verbatim; legacy wires synthesize ids deterministically (history order, then
  the deferred queue). Ids are the address space of projection edits — never
  reuse or renumber them
- **Projection edits** (`context.edit_message`): `applyMessageEdit(targetId,
  replacement|null)` records a persisted edit (`null` = removed from the
  projection, an array = replaced content) and `applyMessageEdits` applies the
  table to a message list. Live writes validate strictly; replay tolerates
  dangling targets (no-op). Raw history is never rewritten — UI/export/trace/
  resume keep reading it
- Handle loop events: step.begin/end, content.part, tool.call/result,
  thinking.delta (via `appendLoopEvent`)
- Snapshots: `toJSONSnapshot`/`restoreJSONSnapshot` (persisted after
  compaction, used for the replay fast-path; the payload carries
  `messageEdits`)
- Cleanup: `dropVacuousOpenMessages` (drop assistant messages that carry only
  thinking content or nothing when a turn is interrupted)
- Authorship: `identity.ts` holds the only predicates that answer "did the user
  speak?" — `isRealUserPrompt` (a turn the user could undo: direct user message
  or user-triggered skill activation) and `isUserAuthoredMessage` (the user's
  own words: `origin.kind === 'user'` only). Every injection lands in history
  as a user-role message, so no call site may compare the role itself; the
  guard is `test/agent/context-identity-guard.test.ts`

## Dependencies
- Depends on: `Agent` (hub; reaches records/background/replayBuilder/injection)
- Depended on by: `Agent`, `FullCompaction` (reads history to compress),
  `AgentServices.context`

## Boundaries
- Does NOT: decide what to do next (that is loop/turn); it only maintains what
  the current state is
- No UI events during restore; `emitStatusUpdated` is live-path only
- openSteps reference identity: step.begin pushes the SAME message object into
  history and openSteps; snapshot restore rebuilds it via history indices —
  do NOT switch to value copies
- Token gauge basis: `step.end` uses measured provider usage; compaction uses
  full-request estimation (system prompt + tool schemas + messages); an edit
  inside the measured prefix adjusts the gauge by the delta against the
  message's *current* projection (a second edit replaces, never stacks)
- Every LLM-bound read path must apply edits in the same order: micro
  window → `applyMessageEdits` → `project()` (`messagesForLLM`, `messages`,
  `tokenCountWithPending`, the compaction summarizer input)

## Extension points
- New content part type: add to ltod `ContentPart` (projection / serialization
  / counting follow)
- New projection strategy: modify `projector.ts` (current: full projection +
  synthesized missing messages); new projection-edit consumers must go through
  `applyMessageEdits` so the raw/projection split stays intact
