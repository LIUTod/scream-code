/**
 * Build trace cells from a session's wire log (`wire.jsonl`).
 *
 * The wire log records the full conversation trajectory: user prompts, model
 * requests (request.header), step content blocks (thinking / text / tool-call),
 * tool calls and results, usage records and compactions. This module replays
 * the log in order and flattens it into the closed `TraceCell` model.
 *
 * Parsing is intentionally loose (records are plain JSON) so the command does
 * not depend on the agent-core wire types; unknown/foreign records are
 * skipped defensively.
 */

import { readFileSync } from 'node:fs';

import type { TraceCell } from './trace-types';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rec = asRecord(item);
    return rec ? [rec] : [];
  });
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === 'string' ? [item] : []));
}

/** Concatenate the text of content parts (text + thinking) for a prompt. */
function contentPartsText(parts: unknown): string {
  return asRecordArray(parts)
    .map((part) => asString(part['text']) ?? '')
    .join('');
}

interface BlockAccum {
  type: 'thinking' | 'text';
  text: string;
}

interface ToolAccum {
  name: string;
  argsText: string;
  resultText: string;
  isError?: boolean;
  startedAt?: number;
  callSeq: number;
}

export interface BuildTraceInput {
  wirePath: string;
  onProgress?: (loaded: number) => void;
}

/**
 * Replay `wire.jsonl` and produce ordered trace cells.
 * Throws when the file is missing or contains no usable records.
 */
export function buildTraceCells({ wirePath }: BuildTraceInput): TraceCell[] {
  const rows = readWireRows(wirePath);
  if (rows.length === 0) {
    throw new Error(`no wire records in ${wirePath}`);
  }

  const cells: TraceCell[] = [];
  let lastTime: number | undefined;
  let nextIndex = 1;
  let lastCell: TraceCell | undefined;

  const pushCell = (
    kind: TraceCell['kind'],
    text: string,
    fields: Omit<TraceCell, 'index' | 'kind' | 'text' | 'timeSeconds'>,
    time: number | undefined,
  ): TraceCell => {
    // Close the previous cell's time window for the timeline time mode.
    if (lastCell && time !== undefined && lastCell.endAt === undefined) {
      lastCell.endAt = time;
    }
    const seconds = time !== undefined && lastTime !== undefined ? (time - lastTime) / 1000 : null;
    if (time !== undefined) lastTime = time;
    const cell: TraceCell = {
      index: nextIndex++,
      kind,
      text,
      timeSeconds: seconds,
      turn: turnNo,
      startedAt: time,
      ...fields,
    };
    cells.push(cell);
    lastCell = cell;
    return cell;
  };

  // Stream state across records.
  let currentStepUuid: string | undefined;
  let currentStepStartTime: number | undefined;
  let currentBlocks: BlockAccum[] = [];
  let currentBlock: BlockAccum | undefined;
  let pendingTools = new Map<string, ToolAccum>();
  let stepTools: ToolAccum[] = [];
  let toolsInStep: string[] = [];
  let stepUsage: Record<string, number> | undefined;
  let stepFinishReason: string | undefined;
  let stepTtftMs: number | undefined;
  let stepDecodingMs: number | undefined;
  let stepModel: string | undefined;
  let currentTurnStart: number | undefined;
  // System-context changes (config/tools) coalesce into the next user turn
  // instead of producing a noisy standalone row per update.
  let pendingSystem: string[] = [];
  let lastSystemTime: number | undefined;
  let turnNo = 0;

  const flushPendingSystem = (time: number | undefined) => {
    if (pendingSystem.length === 0) return;
    pushCell(
      'system',
      pendingSystem.join(' · '),
      { requestOnly: true, sourceSeq: undefined, startedAt: lastSystemTime },
      time,
    );
    pendingSystem = [];
    lastSystemTime = undefined;
  };

  const finalizeStep = (time: number | undefined) => {
    if (currentStepUuid === undefined) return;
    const thinking = currentBlocks.filter((b) => b.type === 'thinking').map((b) => b.text).join('');
    const text = currentBlocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const summary =
      text.trim().replaceAll(/\s+/g, ' ').slice(0, 80) ||
      (thinking.trim() ? '思考…' : '');
    const toolsText = toolsInStep.join(', ');
    const label = toolsText ? `${summary}${summary ? ' — ' : ''}工具: ${toolsText}` : summary;
    const messageCell = pushCell(
      'message',
      label || '(空回复)',
      {
        sourceSeq: undefined,
        inputDetail: undefined,
        outputDetail: text || undefined,
        thinkingDetail: thinking || undefined,
        input: stepUsage?.['inputOther'],
        cacheRead: stepUsage?.['inputCacheRead'],
        cacheWrite: stepUsage?.['inputCacheCreation'],
        output: stepUsage?.['output'],
        ttftMs: stepTtftMs,
        decodingMs: stepDecodingMs,
        model: stepModel,
        finishReason: stepFinishReason,
        startedAt: currentStepStartTime,
      },
      time,
    );
    // The message cell's own duration is the step duration.
    if (currentStepStartTime !== undefined && time !== undefined) {
      messageCell.timeSeconds = (time - currentStepStartTime) / 1000;
      messageCell.endAt = time;
    }
    // Tool results follow the message that issued the calls.
    for (const tool of stepTools) {
      pushCell(
        'tool',
        `${tool.name}${tool.isError ? ' ✗' : ' ✓'}`,
        {
          inputDetail: tool.argsText,
          outputDetail: tool.resultText || undefined,
          result: tool.resultText.replaceAll(/\s+/g, ' ').slice(0, 80) || undefined,
          isError: tool.isError,
          sourceSeq: tool.callSeq,
          startedAt: tool.startedAt,
        },
        time,
      );
    }
    currentStepUuid = undefined;
    currentStepStartTime = undefined;
    currentBlocks = [];
    currentBlock = undefined;
    pendingTools = new Map();
    stepTools = [];
    toolsInStep = [];
    stepUsage = undefined;
    stepFinishReason = undefined;
    stepTtftMs = undefined;
    stepDecodingMs = undefined;
    stepModel = undefined;
  };

  // Dispatch a loop event (the `event` payload of `context.append_loop_event`).
  const handleLoopEvent = (
    event: Record<string, unknown>,
    time: number | undefined,
    seq: number,
  ): void => {
    switch (asString(event['type'])) {
      case 'step.begin': {
        currentStepUuid = asString(event['stepUuid']) ?? asString(event['uuid']);
        currentStepStartTime = time;
        currentBlocks = [];
        currentBlock = undefined;
        pendingTools = new Map();
        toolsInStep = [];
        break;
      }
      case 'block.start': {
        const blockType = asString(event['blockType']);
        if (blockType === 'thinking' || blockType === 'text') {
          currentBlock = { type: blockType, text: '' };
          currentBlocks.push(currentBlock);
        }
        break;
      }
      case 'content.part': {
        const part = asRecord(event['part']);
        // ThinkPart carries its text under `think`, TextPart under `text`.
        const text = asString(part?.['text']) ?? asString(part?.['think']) ?? '';
        if (!text) break;
        const isThink = part?.['type'] === 'think' || part?.['type'] === 'thinking';
        if (currentBlock) {
          currentBlock.text += text;
        } else {
          // Older wires have no block boundaries: keep a fallback block
          // matching the part kind so thinking and text stay separate.
          const fallback = currentBlocks.at(-1);
          if (fallback && fallback.type === (isThink ? 'thinking' : 'text')) fallback.text += text;
          else currentBlocks.push({ type: isThink ? 'thinking' : 'text', text });
        }
        break;
      }
      case 'block.end': {
        currentBlock = undefined;
        break;
      }
      case 'tool.call': {
        const name = asString(event['name']) ?? 'tool';
        const args = event['args'];
        const argsText = typeof args === 'string' ? args : JSON.stringify(args ?? '');
        const toolCallId =
          asString(event['toolCallId']) ?? asString(event['uuid']) ?? `${name}-${seq}`;
        pendingTools.set(toolCallId, {
          name,
          argsText,
          resultText: '',
          startedAt: time,
          callSeq: seq,
        });
        if (!toolsInStep.includes(name)) toolsInStep.push(name);
        break;
      }
      case 'tool.result': {
        const toolCallId = asString(event['toolCallId']) ?? '';
        const pending = pendingTools.get(toolCallId);
        const resultRec = asRecord(event['result']);
        const isError =
          resultRec?.['isError'] === true ||
          resultRec?.['is_error'] === true ||
          asString(resultRec?.['error_name']) !== undefined;
        const resultText =
          asString(resultRec?.['output']) ??
          asString(resultRec?.['result']) ??
          asString(resultRec?.['error_message']) ??
          '';
        if (pending) {
          pending.resultText = resultText;
          pending.isError = isError;
          stepTools.push(pending);
          pendingTools.delete(toolCallId);
        }
        break;
      }
      case 'step.end': {
        const usage = asRecord(event['usage']);
        if (usage) {
          stepUsage = {
            inputOther: asNumber(usage['inputOther']) ?? 0,
            inputCacheRead: asNumber(usage['inputCacheRead']) ?? 0,
            inputCacheCreation: asNumber(usage['inputCacheCreation']) ?? 0,
            output: asNumber(usage['output']) ?? 0,
          };
        }
        stepFinishReason = asString(event['finishReason']);
        stepTtftMs = asNumber(event['llmFirstTokenLatencyMs']);
        stepDecodingMs = asNumber(event['llmStreamDurationMs']);
        stepModel = asString(event['reportedModel']);
        finalizeStep(time);
        break;
      }
      default:
        break;
    }
  };

  for (const { seq, time, record } of rows) {
    const type = asString(record['type']);
    switch (type) {
      case 'context.append_loop_event': {
        const event = asRecord(record['event']);
        if (!event) break;
        handleLoopEvent(event, time, seq);
        break;
      }
      case 'turn.prompt': {
        finalizeStep(time);
        turnNo += 1;
        flushPendingSystem(time);
        const input = record['input'];
        const text = contentPartsText(input).trim();
        pushCell(
          'user',
          text.replaceAll(/\s+/g, ' ').slice(0, 80) || '(空输入)',
          { opensTurn: true, inputDetail: text || undefined, sourceSeq: seq },
          time,
        );
        currentTurnStart = time;
        break;
      }
      case 'turn.steer': {
        const input = record['input'];
        const text = contentPartsText(input).trim();
        pushCell(
          'context',
          `转向: ${text.replaceAll(/\s+/g, ' ').slice(0, 80)}`,
          { inputDetail: text || undefined, sourceSeq: seq },
          time,
        );
        break;
      }
      case 'request.header': {
        const provider = asString(record['provider']) ?? '';
        const model = asString(record['model']) ?? '';
        const tools = asRecordArray(record['activeTools']).map((t) => asString(t['name']) ?? '');
        pushCell(
          'system',
          `请求 ${provider ? `${provider}/` : ''}${model}`,
          {
            requestOnly: true,
            inputDetail: tools.length > 0 ? `工具: ${tools.join(', ')}` : undefined,
            sourceSeq: seq,
          },
          time,
        );
        break;
      }
      case 'tools.set_active_tools': {
        // `names` is a plain string[] in the wire (tool names); tolerate the
        // object shape defensively.
        const names = asStringArray(record['names']).length > 0
          ? asStringArray(record['names'])
          : asRecordArray(record['names']).map((n) => asString(n['name']) ?? '');
        pendingSystem.push(`工具集: ${names.join(', ')}`);
        lastSystemTime = time;
        break;
      }
      case 'config.update': {
        const cfg = asRecord(record);
        const bits: string[] = [];
        if (asString(cfg?.['modelAlias'])) bits.push(`模型别名: ${cfg!['modelAlias']}`);
        if (asString(cfg?.['systemPrompt'])) bits.push('系统提示词已更新');
        if (bits.length === 0) break;
        pendingSystem.push(bits.join(' · '));
        lastSystemTime = time;
        break;
      }
      case 'usage.record': {
        // Aggregated into step cells via step.end usage; keep as a marker
        // when no step context is present.
        if (currentStepUuid === undefined) {
          const usage = asRecord(record['usage']);
          pushCell(
            'context',
            'usage',
            {
              input: asNumber(usage?.['inputOther']),
              cacheRead: asNumber(usage?.['inputCacheRead']),
              cacheWrite: asNumber(usage?.['inputCacheCreation']),
              output: asNumber(usage?.['output']),
              sourceSeq: seq,
            },
            time,
          );
        }
        break;
      }
      case 'full_compaction.begin': {
        finalizeStep(time);
        const reason = asString(record['reason']);
        const instruction = asString(record['instruction']);
        const source = asString(record['source']);
        pushCell(
          'compacted',
          `压缩上下文${reason ? `（${reason}）` : ''}`,
          {
            sourceSeq: seq,
            startedAt: currentTurnStart,
            inputDetail: instruction || undefined,
            result: source ? `来源: ${source}` : undefined,
          },
          time,
        );
        break;
      }
      case 'micro_compaction.apply': {
        finalizeStep(time);
        const reason = asString(record['reason']);
        pushCell(
          'compacted',
          `微压缩${reason ? `（${reason}）` : ''}`,
          { sourceSeq: seq, startedAt: currentTurnStart },
          time,
        );
        break;
      }
      default:
        break;
    }
  }

  // Flush an unfinished final step and any trailing system-context changes.
  finalizeStep(undefined);
  flushPendingSystem(undefined);

  return cells;
}

interface WireRow {
  seq: number;
  time?: number;
  record: Record<string, unknown>;
}

function readWireRows(wirePath: string): WireRow[] {
  const content = readFileSync(wirePath, 'utf8');
  const rows: WireRow[] = [];
  let seq = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    seq += 1;
    try {
      const parsed: unknown = JSON.parse(line);
      const rec = asRecord(parsed);
      if (!rec) continue;
      const time = asNumber(rec['time']);
      rows.push({ seq, time, record: rec });
    } catch {
      // Skip malformed lines; the wire log is append-only and a torn tail
      // write must not break the trace.
    }
  }
  return rows;
}
