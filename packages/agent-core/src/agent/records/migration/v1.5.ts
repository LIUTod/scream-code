import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.4 -> v1.5 is a bump-only migration.
 *
 * v1.5 adds the `context.prefix_break` observability record (prefix-stability
 * break points). It is an additive, diagnostic-only record type written only
 * by new sessions, so records from v1.4 remain valid JSON without
 * transformation.
 */
export const migrateV1_4ToV1_5: WireMigration = {
  sourceVersion: '1.4',
  targetVersion: '1.5',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
