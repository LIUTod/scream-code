import { canonicalToolName } from '../../../tools/tool-names';
import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.8 -> v1.9 renames three built-in tools to PascalCase like every other
 * built-in: `ast_grep` -> `AstGrep`, `ast_edit` -> `AstEdit`, `python` ->
 * `Python` (`tools/tool-names.ts`).
 *
 * Every record that names a tool is rewritten, so a resumed session shows
 * one name for each tool, the model's history uses the names its tools now
 * have, and a stored grant or active-tool list keeps applying:
 *   - assistant tool calls in `context.append_message` and in the history of
 *     `context.snapshot` (live and deferred messages);
 *   - `tool.call` loop events (`context.append_loop_event`);
 *   - `tools.set_active_tools` names and `request.header` activeTools;
 *   - `permission.record_approval_result` / `permission.record_decision`
 *     tool names, and the tool part of approve-for-session rules
 *     (`sessionApprovalRule`, `permission.record_grant_revocation`).
 * Anything else, and any record without the expected shape, passes through.
 */

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renameNames(value: unknown): unknown {
  return Array.isArray(value) ? value.map((name) => (typeof name === 'string' ? canonicalToolName(name) : name)) : value;
}

/** `python` -> `Python`, `ast_grep(foo)` -> `AstGrep(foo)`; other rules unchanged. */
function renameRulePattern(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const open = value.indexOf('(');
  if (open === -1) return canonicalToolName(value);
  return canonicalToolName(value.slice(0, open)) + value.slice(open);
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

function renameToolName(record: WireMigrationRecord): WireMigrationRecord {
  return typeof record['toolName'] === 'string'
    ? { ...record, toolName: canonicalToolName(record['toolName']) }
    : record;
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
      case 'tools.set_active_tools':
        return { ...record, names: renameNames(record['names']) };
      case 'request.header':
        return { ...record, activeTools: renameNames(record['activeTools']) };
      case 'permission.record_decision':
        return renameToolName(record);
      case 'permission.record_approval_result': {
        const renamed = renameToolName(record);
        return 'sessionApprovalRule' in renamed
          ? { ...renamed, sessionApprovalRule: renameRulePattern(renamed['sessionApprovalRule']) }
          : renamed;
      }
      case 'permission.record_grant_revocation':
        return { ...record, pattern: renameRulePattern(record['pattern']) };
      default:
        return record;
    }
  },
};
