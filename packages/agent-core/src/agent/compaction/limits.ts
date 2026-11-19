/**
 * How many compaction debug-trail entries survive: compaction keeps this many,
 * restore keeps this many, and the wire reader trims a snapshot's trail to it
 * before parsing (records/persistence.ts). One value, so the three agree.
 */
export const MAX_COMPACTED_HISTORY_ENTRIES = 2;
