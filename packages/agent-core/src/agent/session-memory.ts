import type { Agent } from './index';

interface ToolExecutionEvent {
  type: 'tool_execution';
  toolName: string;
  argsSummary: string;
  isError: boolean;
  timestamp: number;
  step: number;
}

interface ErrorEvent {
  type: 'error';
  message: string;
  isError: true;
  timestamp: number;
  step: number;
}

type SessionEvent = ToolExecutionEvent | ErrorEvent;

const MAX_EVENTS = 50;
const MAX_SUMMARY_LENGTH = 1500;

/**
 * In-memory session running notes.
 *
 * Tracks tool executions and errors during the current session so a brief
 * summary can be injected after compaction, preventing the model from losing
 * its bearings when detailed conversation history is compressed away.
 */
export class SessionMemory {
  private events: SessionEvent[] = [];
  private lastInjectedStep = -1;

  constructor(private readonly agent: Agent) {}

  /** Record a tool execution (success or failure). */
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
    });
    // Keep bounded to prevent unbounded growth
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  /** Record a session-level error. */
  recordError(message: string, step: number): void {
    this.events.push({
      type: 'error',
      message,
      isError: true,
      timestamp: Date.now(),
      step,
    });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  /** Build a markdown summary of recent activity since the last injection. */
  getSessionSummary(): string {
    const newEvents = this.events.filter(
      (e) => e.step > this.lastInjectedStep,
    );
    if (newEvents.length === 0) return '';

    this.lastInjectedStep = this.events[this.events.length - 1]?.step ?? this.lastInjectedStep;

    const recent = newEvents.slice(-15);

    const toolExecs = recent.filter((e) => e.type === 'tool_execution');
    const errors = recent.filter((e) => e.type === 'error');

    if (toolExecs.length === 0 && errors.length === 0) return '';

    const lines: string[] = ['## 当前会话状态', ''];

    if (errors.length > 0) {
      lines.push('### 最近错误', '');
      for (const e of errors) {
        lines.push(`- ${e.message}`);
      }
      lines.push('');
    }

    if (toolExecs.length > 0) {
      lines.push('### 最近操作', '');
      // Group consecutive same-tool calls
      for (const e of toolExecs.slice(-10)) {
        const status = e.isError ? '❌ 失败' : '✅';
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

  /** Reset for a new session. */
  clear(): void {
    this.events.length = 0;
    this.lastInjectedStep = -1;
  }
}
