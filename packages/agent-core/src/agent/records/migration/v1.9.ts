import { canonicalToolName } from '../../../tools/tool-names';
import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.8 -> v1.9 renames three built-in tools to PascalCase like every other
 * built-in: `ast_grep` -> `AstGrep`, `ast_edit` -> `AstEdit`, `python` ->
 * `Python` (`tools/tool-names.ts`).
 *
 * Only tool calls are rewritten, so a resumed session shows one name per tool
 * and the model's history uses the names its tools now have:
 *   - assistant tool calls in `context.append_message` and in the history of
 *     `context.snapshot` (live and deferred messages);
 *   - `tool.call` loop events (`context.append_loop_event`).
 * Tool lists and permission rules stay as written: `tools.set_active_tools`
 * replays through `setActiveTools`, which adds the current name next to an old
 * one, and rule matching accepts the old name. Leaving them keeps a user or
 * plugin tool that really has one of the old names working. Anything else, and
 * any record without the expected shape, passes through.
 */

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renameMessage(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message['toolCalls'])) return message;
  return {
    ...message,
    toolCalls: message['toolCalls'].map((call: unknown) =>
      isRecord(call) && typeof call['name'] === 'string' ? { ...call, name: canonicalToolName(call['name']) } : call,
    ),
  };
}

function renameMessages(value: unknown): unknown {
  return Array.isArray(value) ? value.map(renameMessage) : value;
}

export const migrateV1_8ToV1_9: WireMigration = {
  sourceVersion: '1.8',
  targetVersion: '1.9',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    switch (record.type) {
      case 'context.append_message':
        return { ...record, message: renameMessage(record['message']) };
      case 'context.append_loop_event': {
        const event = record['event'];
        if (!isRecord(event) || event['type'] !== 'tool.call' || typeof event['name'] !== 'string') return record;
        return { ...record, event: { ...event, name: canonicalToolName(event['name']) } };
      }
      case 'context.snapshot': {
        const snapshot = record['snapshot'];
        if (!isRecord(snapshot)) return record;
        return {
          ...record,
          snapshot: {
            ...snapshot,
            history: renameMessages(snapshot['history']),
            deferredMessages: renameMessages(snapshot['deferredMessages']),
          },
        };
      }
      default:
        return record;
    }
  },
};
