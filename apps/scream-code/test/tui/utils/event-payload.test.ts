import { describe, expect, it } from 'vitest';

import { MAX_TRANSCRIPT_ERROR_LINES, STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import {
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

  it('caps accumulated streaming preview text', () => {
    const current = 'a'.repeat(STREAMING_ARGS_PREVIEW_MAX_CHARS - 2);

    expect(appendStreamingArgsPreview(current, 'bcdef')).toBe(`${current}bc`);
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
