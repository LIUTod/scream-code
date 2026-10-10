import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.6 -> v1.7 is a bump-only migration.
 *
 * v1.7 adds the `permission.record_decision` audit record (a call stopped by a
 * policy, or an approval that was cancelled or timed out) and the optional
 * `requestSummary` field on approval payloads. Both are additive: the new
 * record type is written only by new sessions and restores as a no-op, so
 * records from v1.6 remain valid JSON without transformation.
 */
export const migrateV1_6ToV1_7: WireMigration = {
  sourceVersion: '1.6',
  targetVersion: '1.7',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
