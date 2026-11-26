import { afterEach, describe, expect, it, vi } from 'vitest';

import { setProcessTitle } from '#/tui/utils/proctitle';

function writtenTitles(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

describe('setProcessTitle', () => {
  const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalTitle = process.title;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTty === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
    else Object.defineProperty(process.stdout, 'isTTY', originalTty);
    process.title = originalTitle;
  });

  function asTty(): void {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  }

  it('puts the prefix on the terminal title only, never on the process name', () => {
    asTty();
    const writes = writtenTitles();
    setProcessTitle('fix-auth-bug', 's1', '⠋ ');
    expect(writes).toEqual(['\u001B]0;⠋ fix-auth-bug\u0007']);
    expect(process.title).toBe('fix-auth-bug');
  });

  it('does not let a title end the escape sequence early or start another one', () => {
    asTty();
    const writes = writtenTitles();
    setProcessTitle('fine\u0007\u001B]0;owned\u0007 name', 's1');
    expect(writes).toHaveLength(1);
    const sequence = writes[0] ?? '';
    // One sequence: it starts with the title command and ends with the single BEL it was given.
    expect(sequence.startsWith('\u001B]0;')).toBe(true);
    expect(sequence.endsWith('\u0007')).toBe(true);
    expect(sequence.slice(0, -1).includes('\u0007')).toBe(false);
    expect(sequence.slice('\u001B]0;'.length).includes('\u001B')).toBe(false);
  });

  it('writes nothing to a stream that is not a terminal', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const writes = writtenTitles();
    setProcessTitle('anything', 's1', '⠋ ');
    expect(writes).toEqual([]);
  });
});
