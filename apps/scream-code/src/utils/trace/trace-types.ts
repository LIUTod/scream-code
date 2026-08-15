/**
 * Trace cell model for the `/trace` command.
 *
 * The cell shape mirrors the reference trajectory record model (DeepSeek
 * harness, ui-trajectory) — a closed set of kinds plus per-cell facts (index,
 * summary, token counts, duration, details) — adapted to this codebase:
 * no React dependency, no dsh-internal types.
 */

export type TraceCellKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool';

export interface TraceCell {
  /** 1-based record index shown as `#N`. */
  index: number;
  kind: TraceCellKind;
  /** Single-line summary; CSS ellipsis when it overflows. */
  text: string;
  /** Whether this user record opens a new model turn. */
  opensTurn?: boolean;
  /** Source wire seq for cross-record navigation. */
  sourceSeq?: number;
  /** 1-based model-turn number this record belongs to (user records open turns). */
  turn?: number;
  /** System-context record: shown in the ledger but excluded from the timeline. */
  requestOnly?: boolean;
  /** Full request/message content for the details panel. */
  inputDetail?: string;
  /** Full assistant/tool-result content for the details panel. */
  outputDetail?: string;
  /** Full assistant reasoning content for the details panel. */
  thinkingDetail?: string;
  /** Tool-only result summary paired with the call in the same record. */
  result?: string;
  /** Tool-only result failure state. */
  isError?: boolean;
  /** Own duration in seconds, or `null` when unknown. */
  timeSeconds: number | null;
  /** Unix epoch milliseconds when this record's operation started. */
  startedAt?: number | null;
  /** Message-only input token count. */
  input?: number;
  /** Message-only input tokens served from a provider cache. */
  cacheRead?: number;
  /** Message-only input tokens written into a provider cache. */
  cacheWrite?: number;
  /** Message-only completion token count. */
  output?: number;
  /** Message-only first-token latency (ms) from the model request. */
  ttftMs?: number;
  /** Message-only streamed decoding duration (ms). */
  decodingMs?: number;
  /** Actual model that served the message (may differ from the alias). */
  model?: string;
  /** Message-only finish reason from the model request. */
  finishReason?: string;
  /** Absolute end time (epoch ms) for the timeline's time mode. */
  endAt?: number;
}

export interface TraceDocument {
  title: string;
  sessionId: string;
  createdAt: number;
  cells: TraceCell[];
}
