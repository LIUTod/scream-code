import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.7 -> v1.8 is a bump-only migration.
 *
 * v1.8 adds the `permission.record_grant_revocation` record (a memorized
 * approve-for-session pattern the user revoked). It is additive: only new
 * sessions write it, and a wire without one replays exactly as before, so
 * records from v1.7 remain valid JSON without transformation.
 */
export const migrateV1_7ToV1_8: WireMigration = {
  sourceVersion: '1.7',
  targetVersion: '1.8',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
