# records — Session Wire Log & Replay

## Responsibility
- Persist every agent state change: `logRecord(type, payload)` writes the
  append-only wire.jsonl (behind the `AgentRecordPersistence` abstraction;
  filesystem is the default implementation)
- Resume replay: `replay()` restores in-memory state from the wire (snapshot
  fast-path: when a `context.snapshot` record exists, skip the folded
  context-content records that predate it). Records stream straight into
  `restore()`: neither the file nor the record list is held in memory, because
  a wire can legitimately reach several GB on a long-lived session. Only the
  two paths that must see the whole stream twice buffer it — a migration
  rewrite (`shouldRewrite` re-serializes every record) and a wire file newer
  than this build (its parse-skip filter is disabled).
- The snapshot parse-skip lives in `read()`: EVERY persistence implementation
  must drop folded records that predate the last snapshot on a same-version
  wire, because `replay()` applies whatever it is handed. `InMemory` and
  `FileSystem` readers share that rule.
- Version migration: `migrateWireRecord` + `WireMigration`; migrate records
  one-by-one when the wire protocol version bumps
- Blob references: large content is offloaded to blobs via `BlobStore.offload`
  as `blobref:` URLs; `rehydrateParts` resolves them back on load

## Dependencies
- Depends on: `Agent` (hub), `AgentRecordPersistence`, `BlobStore`
- Depended on by: `ContextMemory`, `Agent` (every state method calls `logRecord`)

## Boundaries
- Does NOT: decide how state is updated (that is each subsystem's job); it only
  records, restores and migrates
- Restore contract: `restoreAgentRecord` must NOT emit UI events / call the LLM
  / run tools / touch the filesystem
- `tools.register_user_tool` records are serializable-only (`name`,
  `description`, `parameters`, optional `ownerPluginId`): a registered
  closure (`execute`) never enters the wire — replay falls back to the
  host-callback path on purpose
- Snapshot mechanism (`context.snapshot`): written after compaction; replay
  skips folded records before it. When adding record types keep backward
  compatibility — unknown types are silently ignored

## Extension points
- Swap the backing store = implement `AgentRecordPersistence` (InMemory and
  FileSystem implementations already exist)
- New state type = add to `AgentRecordEvents` + a `restoreAgentRecord` case
