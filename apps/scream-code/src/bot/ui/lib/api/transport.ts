export type BotConnectionStatus = 'local' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error' | 'disconnected';

export interface BotConnectionState {
  readonly status: BotConnectionStatus;
  readonly error: string | null;
  readonly retryInMs: number | null;
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id: string | undefined;
}

/** Incremental SSE parser: UTF-8, CR/LF/CRLF, multiline data and split delimiters. */
export class BotSseParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private offset = 0;
  private skipLf = false;
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  private frameSize = 0;

  constructor(private readonly dispatch: (frame: SseFrame) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let index = this.offset; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (this.skipLf) {
        this.skipLf = false;
        if (char === '\n') { start = index + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      this.line(this.buffer.slice(start, index));
      this.skipLf = char === '\r';
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    this.offset = this.buffer.length;
    if (this.buffer.length + this.frameSize > 1_048_576) throw new StreamProtocolError('SSE frame exceeds size limit');
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0 || this.id !== undefined) {
        this.dispatch({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      }
      this.data = [];
      this.event = '';
      this.id = undefined;
      this.frameSize = 0;
      return;
    }
    this.frameSize += line.length;
    if (this.frameSize > 1_048_576) throw new StreamProtocolError('SSE frame exceeds size limit');
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? '' : line.slice(separator + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}

export class StreamProtocolError extends Error {}

export function retryDelay(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
  });
}
