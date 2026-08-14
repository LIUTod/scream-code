import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.3 -> v1.4 is a bump-only migration.
 *
 * v1.4 adds per-request `request.header` snapshots and `block.start` /
 * `block.end` trajectory markers. They are additive record types written
 * only by new sessions, so records from v1.3 remain valid JSON without
 * transformation.
 */
export const migrateV1_3ToV1_4: WireMigration = {
  sourceVersion: '1.3',
  targetVersion: '1.4',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
