# context — Message History, Projection & Token Gauge

## Responsibility
- Maintain session message history (`history`), in-flight steps (`openSteps`),
  and the token gauge (`tokenCount` + covered count)
- Assemble messages sent to the LLM: `messagesForLLM` (projection +
  prefix-cache stability observation)
- Handle loop events: step.begin/end, content.part, tool.call/result,
  thinking.delta (via `appendLoopEvent`)
- Snapshots: `toJSONSnapshot`/`restoreJSONSnapshot` (persisted after
  compaction, used for the replay fast-path)
- Cleanup: `dropVacuousOpenMessages` (drop assistant messages that carry only
  thinking content or nothing when a turn is interrupted)

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
  full-request estimation (system prompt + tool schemas + messages)

## Extension points
- New content part type: add to ltod `ContentPart` (projection / serialization
  / counting follow)
- New projection strategy: modify `projector.ts` (current: full projection +
  synthesized missing messages)
