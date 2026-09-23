import { describe, expect, it } from 'vitest';

import {
  MAX_TRANSCRIPT_ERROR_LINES,
  STREAMING_ARGS_BUFFER_MAX_CHARS,
  STREAMING_ARGS_PREVIEW_MAX_CHARS,
} from '#/tui/constant/streaming';
import {
  appendSessionHeaderHint,
  appendStreamingArgsPreview,
  parseStreamingArgs,
  truncateErrorMessage,
} from '#/tui/utils/event-payload';

describe('streaming tool argument payload helpers', () => {
  it('parses complete JSON arguments for finalized small previews', () => {
    expect(parseStreamingArgs('{"command":"echo hi","path":"/tmp/a"}')).toEqual({
      command: 'echo hi',
      path: '/tmp/a',
    });
  });

  it('accumulates well past the parse-preview window, bounded by the buffer cap', () => {
    // The 8KB parse window must NOT cap accumulation — live previews read
    // from the tail of the full buffer.
    const current = 'a'.repeat(STREAMING_ARGS_PREVIEW_MAX_CHARS * 2);
    expect(appendStreamingArgsPreview(current, 'bcdef')).toBe(`${current}bcdef`);

    const nearCap = 'a'.repeat(STREAMING_ARGS_BUFFER_MAX_CHARS - 2);
    expect(appendStreamingArgsPreview(nearCap, 'bcdef')).toBe(`${nearCap}bc`);
  });

  it('parses only bounded preview fields from oversized streaming arguments', () => {
    const oversized = `{"command":"echo ok","description":"${'x'.repeat(
      STREAMING_ARGS_PREVIEW_MAX_CHARS + 100,
    )}"}`;

    expect(parseStreamingArgs(oversized)).toEqual({ command: 'echo ok' });
  });
});

describe('truncateErrorMessage', () => {
  it('returns input unchanged when within the line cap', () => {
    const message = 'line one\nline two\nline three';
    expect(truncateErrorMessage(message)).toBe(message);
  });

  it('drops blank lines before counting', () => {
    const message = 'real one\n\n  \nreal two';
    expect(truncateErrorMessage(message)).toBe('real one\nreal two');
  });

  it('caps at maxLines and appends a remaining-count hint', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${String(i + 1)}`);
    const message = lines.join('\n');
    const truncated = truncateErrorMessage(message);
    const expectedKept = lines.slice(0, MAX_TRANSCRIPT_ERROR_LINES).join('\n');
    const remaining = lines.length - MAX_TRANSCRIPT_ERROR_LINES;
    expect(truncated).toBe(`${expectedKept}\n… (${String(remaining)} more lines)`);
  });

  it('honors a custom maxLines argument', () => {
    const message = 'a\nb\nc\nd\ne';
    expect(truncateErrorMessage(message, 3)).toBe('a\nb\nc\n… (2 more lines)');
  });

  it('returns empty string for an all-blank message', () => {
    expect(truncateErrorMessage('\n  \n\t\n')).toBe('');
  });
});


describe('appendSessionHeaderHint', () => {
  const hint = (name: string): string => `Set session_header = "${name}" under this provider.`;

  it('appends the captured header name from a missing-header error', () => {
    const message =
      '[provider.api_error] 400 Error from provider: Request is missing x-sample-session and cannot be routed efficiently.';
    const out = appendSessionHeaderHint(message, hint);
    expect(out).toContain(message);
    expect(out).toContain('Set session_header = "x-sample-session"');
  });

  it('matches case-insensitive missing-header wording', () => {
    const out = appendSessionHeaderHint('400 MISSING X-Session-Id header required', hint);
    expect(out).toContain('session_header = "X-Session-Id"');
  });

  it('matches a session-named header followed by the word header', () => {
    const out = appendSessionHeaderHint('400 missing conversation-session header', hint);
    expect(out).toContain('session_header = "conversation-session"');
  });

  it('leaves unrelated messages unchanged', () => {
    const message = '[provider.api_error] 401 invalid api key';
    expect(appendSessionHeaderHint(message, hint)).toBe(message);
  });

  it('does not invent a name when the header token is absent', () => {
    const message = '400 Request is missing required headers';
    expect(appendSessionHeaderHint(message, hint)).toBe(message);
  });

  it('does not hint on non-session header wording', () => {
    expect(appendSessionHeaderHint('400 missing required header', hint)).toBe(
      '400 missing required header',
    );
    expect(appendSessionHeaderHint('401 missing authorization header', hint)).toBe(
      '401 missing authorization header',
    );
    expect(appendSessionHeaderHint('400 missing a header', hint)).toBe('400 missing a header');
  });
});
