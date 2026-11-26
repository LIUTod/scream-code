import { describe, expect, it } from 'vitest';

import type { TranscriptEntry } from '#/tui/types';
import { ScrollCue } from '#/tui/utils/scroll-cue';

let counter = 0;
function entry(kind: TranscriptEntry['kind'], content = 'text'): TranscriptEntry {
  counter += 1;
  return { id: `e${counter}`, kind, renderMode: 'markdown', content };
}

describe('ScrollCue', () => {
  it('says nothing while the view follows the end', () => {
    const cue = new ScrollCue();
    expect(cue.read(true, [entry('user'), entry('assistant')])).toBeNull();
  });

  it('counts only replies that arrive after the view left the end', () => {
    const cue = new ScrollCue();
    const entries = [entry('user'), entry('assistant', 'first answer')];
    expect(cue.read(false, entries)).toEqual({ newReplies: 0 });

    entries.push(entry('assistant', 'second answer'));
    expect(cue.read(false, entries)).toEqual({ newReplies: 1 });

    entries.push(entry('assistant', 'third answer'));
    expect(cue.read(false, entries)).toEqual({ newReplies: 2 });
  });

  it('does not count tool calls, reasoning, status lines or an empty reply as a new message', () => {
    const cue = new ScrollCue();
    const entries = [entry('user')];
    cue.read(false, entries);
    entries.push(
      entry('tool_call', 'ran a command'),
      entry('tool_result', 'its output'),
      entry('thinking', 'weighing options'),
      entry('status', 'a status line'),
      entry('assistant', '   '),
    );
    expect(cue.read(false, entries)).toEqual({ newReplies: 0 });
    entries[entries.length - 1] = { ...entries.at(-1)!, content: 'now it has text' };
    expect(cue.read(false, entries)).toEqual({ newReplies: 1 });
  });

  it('starts over each time the view returns to the end and leaves it again', () => {
    const cue = new ScrollCue();
    const entries = [entry('assistant', 'old')];
    cue.read(false, entries);
    entries.push(entry('assistant', 'while away'));
    expect(cue.read(false, entries)).toEqual({ newReplies: 1 });

    expect(cue.read(true, entries)).toBeNull();
    expect(cue.read(false, entries)).toEqual({ newReplies: 0 });
  });

  it('falls back to every reply still held when the entry it counted from is gone', () => {
    const cue = new ScrollCue();
    const entries = [entry('user'), entry('assistant', 'kept')];
    cue.read(false, entries);
    const trimmed = [entry('assistant', 'a'), entry('assistant', 'b')];
    expect(cue.read(false, trimmed)).toEqual({ newReplies: 2 });
  });
});
