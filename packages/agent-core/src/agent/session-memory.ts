import type { Agent } from './index';

interface ToolExecutionEvent {
  type: 'tool_execution';
  toolName: string;
  argsSummary: string;
  isError: boolean;
  timestamp: number;
  step: number;
  /** Session-level monotonic counter for cross-turn filtering. */
  seq: number;
}

interface ErrorEvent {
  type: 'error';
  message: string;
  isError: true;
  timestamp: number;
  step: number;
  seq: number;
}

type SessionEvent = ToolExecutionEvent | ErrorEvent;

const MAX_EVENTS = 50;
const MAX_SUMMARY_LENGTH = 1500;

export class SessionMemory {
  private events: SessionEvent[] = [];
  private lastInjectedSeq = -1;
  private nextSeq = 1;

  constructor(private readonly agent: Agent) {}

  recordToolExecution(
    toolName: string,
    argsSummary: string,
    isError: boolean,
    step: number,
  ): void {
    this.events.push({
      type: 'tool_execution',
      toolName,
      argsSummary,
      isError,
      timestamp: Date.now(),
      step,
      seq: this.nextSeq++,
    });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  recordError(message: string, step: number): void {
    this.events.push({
      type: 'error',
      message,
      isError: true,
      timestamp: Date.now(),
      step,
      seq: this.nextSeq++,
    });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  getSessionSummary(): string {
    const newEvents = this.events.filter(
      (e) => e.seq > this.lastInjectedSeq,
    );
    if (newEvents.length === 0) return '';

    this.lastInjectedSeq = this.events.at(-1)?.seq ?? this.lastInjectedSeq;

    const recent = newEvents.slice(-15);
    const toolExecs = recent.filter((e) => e.type === 'tool_execution');
    const errors = recent.filter((e) => e.type === 'error');
    if (toolExecs.length === 0 && errors.length === 0) return '';

    const lines: string[] = ['## Current session state', ''];
    if (errors.length > 0) {
      lines.push('### Recent errors', '');
      for (const e of errors) lines.push(`- ${e.message}`);
      lines.push('');
    }
    if (toolExecs.length > 0) {
      lines.push('### Recent actions', '');
      for (const e of toolExecs.slice(-10)) {
        const status = e.isError ? '❌ failed' : '✅';
        const file = e.argsSummary ? ` — ${e.argsSummary}` : '';
        lines.push(`- ${status} ${e.toolName}${file}`);
      }
      lines.push('');
    }

    const joined = lines.join('\n');
    return joined.length > MAX_SUMMARY_LENGTH
      ? joined.slice(0, MAX_SUMMARY_LENGTH - 3) + '...'
      : joined;
  }

  clear(): void {
    this.events.length = 0;
    this.lastInjectedSeq = -1;
    this.nextSeq = 1;
  }
}
