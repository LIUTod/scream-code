/**
 * The transcript has exactly one bounded ingress — `TranscriptController`
 * `.ingestEntry()`. Two producers land there: `appendEntry` (rows that mount
 * their own component) and `ScreamTUI.pushTranscriptEntry` (the live streaming
 * rows that already own one, driven by streaming-ui.ts). These tests drive the
 * real ScreamTUI end to end, because the gap they pin lived in the wiring
 * between the two paths: either one could grow `transcriptEntries` without the
 * bound or the entry cap.
 */
import { describe, expect, it, vi } from 'vitest';

import { MAX_TRANSCRIPT_ENTRIES } from '#/tui/controllers/transcript-controller';
import { ScreamTUI, type ScreamTUIStartupInput } from '#/tui/scream-tui';
import type { ToolCallBlockData, ToolResultBlockData, TranscriptEntry } from '#/tui/types';

/** Sentinel that sits in the middle of the oversized output: a stored entry
 *  still carrying it means the preview bound never ran on that path. */
const MIDDLE_SENTINEL = 'middle-sentinel-line-12345';

/** The ingress's preview budget, plus the elbow room its markers need. */
const OUTPUT_BUDGET_SLACK = 8_000 + 64;

/** Same shape the collapse stub is rendered with (see transcript-controller). */
const STUB_PATTERN = /^…\((\d+) earlier entries collapsed\)$/;

function makeStartupInput(): ScreamTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      wolfpack: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      language: 'zh',
      autoStart: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      like: {},
      fusionPlan: { timeoutSeconds: 600, workerCount: 3 },
      subagentModels: {},
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-ingress',
    resolvedTheme: 'dark',
  };
}

function makeHarness() {
  return {
    setSubagentModelBindings: vi.fn(),
    getConfig: vi.fn(async () => ({})),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    auth: {
      status: vi.fn(async () => ({ providers: [] })),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
  };
}

/** A real TUI, constructed but never started (no terminal attached). */
function makeTui(): ScreamTUI {
  const tui = new ScreamTUI(makeHarness() as never, makeStartupInput());
  vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => undefined);
  return tui;
}

function entry(
  overrides: Partial<TranscriptEntry> & { kind: TranscriptEntry['kind'] },
): TranscriptEntry {
  return {
    id: overrides.id ?? `e-${Math.random().toString(36).slice(2)}`,
    renderMode: 'plain',
    content: '',
    ...overrides,
  };
}

/** A tool result far past the 8k UI preview budget. */
function bigToolResult(id: string): ToolResultBlockData {
  const lines = Array.from({ length: 10_000 }, (_, i) =>
    i === 5_000 ? MIDDLE_SENTINEL : `payload-line-${String(i)}`,
  );
  return { tool_call_id: id, output: lines.join('\n'), is_error: false };
}

function storedOutput(stored: TranscriptEntry | undefined): string {
  return stored?.toolCallData?.result?.output ?? '';
}

describe('bounded transcript ingress', () => {
  it('bounds a large tool output pushed through pushTranscriptEntry', () => {
    const tui = makeTui();

    tui.pushTranscriptEntry(
      entry({
        kind: 'tool_result',
        content: 'Bash',
        toolCallData: {
          id: 'tc-push',
          name: 'Bash',
          args: { command: 'seq 10000' },
          result: bigToolResult('tc-push'),
        },
      }),
    );

    const stored = tui.state.transcriptEntries.at(-1);
    expect(tui.state.transcriptEntries).toHaveLength(1);
    const output = storedOutput(stored);
    // The elided middle never reaches the array, and the preview fits budget.
    expect(output).not.toContain(MIDDLE_SENTINEL);
    expect(output).toContain('lines elided');
    expect(output.length).toBeLessThanOrEqual(OUTPUT_BUDGET_SLACK);
    // Both ends survive, so the preview still reads like the tool output.
    expect(output).toContain('payload-line-0');
    expect(output).toContain('payload-line-9999');
  });

  it('bounds a result that lands after its card was pushed (live tool call)', () => {
    const tui = makeTui();
    const toolCall: ToolCallBlockData = {
      id: 'tc-live',
      name: 'Bash',
      args: { command: 'seq 10000' },
    };

    // The production streaming sequence: the card (and its entry) are pushed
    // when the call starts; its result only exists when the call ends.
    tui.streamingUI.registerToolCall(toolCall);
    expect(tui.state.transcriptEntries).toHaveLength(1);

    tui.streamingUI.completeToolResult('tc-live', bigToolResult('tc-live'));

    const output = storedOutput(tui.state.transcriptEntries[0]);
    expect(output).not.toContain(MIDDLE_SENTINEL);
    expect(output).toContain('lines elided');
    expect(output.length).toBeLessThanOrEqual(OUTPUT_BUDGET_SLACK);
    expect(output).toContain('payload-line-0');
  });

  it('stores non-tool entries untouched, identity included', () => {
    const tui = makeTui();
    const bigPlainText = 'x'.repeat(50_000);
    const thinking = entry({ id: 'th-1', kind: 'thinking', content: bigPlainText });

    tui.pushTranscriptEntry(thinking);

    // Same object, same content — the bound only rewrites tool previews.
    expect(tui.state.transcriptEntries[0]).toBe(thinking);
    expect(tui.state.transcriptEntries[0]!.content).toBe(bigPlainText);

    // A live draft stays mutable through the pushed reference (streaming-ui
    // grows assistant text / thinking on the object it holds; history must see it).
    const draft = entry({ id: 'as-1', kind: 'assistant', content: '' });
    tui.pushTranscriptEntry(draft);
    draft.content = 'streamed answer';
    expect(tui.state.transcriptEntries.at(-1)!.content).toBe('streamed answer');
  });

  it('caps a 5000-entry mixed flood from both producers', () => {
    const tui = makeTui();
    const total = 5_000;

    for (let i = 0; i < total; i++) {
      const row = entry({ id: `f-${String(i)}`, kind: 'status', content: `row-${String(i)}` });
      // Half through the appendEntry path, half through the streaming path.
      if (i % 2 === 0) tui.appendTranscriptEntry(row);
      else tui.pushTranscriptEntry(row);
    }

    const entries = tui.state.transcriptEntries;
    expect(entries.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES + 1);
    // Exactly one stub, at the head: neither producer folds into a second one.
    const stubs = entries.filter((e) => STUB_PATTERN.test(e.content));
    expect(stubs).toHaveLength(1);
    expect(entries[0]).toBe(stubs[0]);
    // Folded + kept accounts for every append — no double count on either path.
    const folded = Number(STUB_PATTERN.exec(entries[0]!.content)![1]);
    expect(folded).toBe(total - (entries.length - 1));
    // The newest rows survive; the folded oldest are gone.
    expect(entries.at(-1)!.content).toBe(`row-${String(total - 1)}`);
    expect(entries.some((e) => e.content === 'row-0')).toBe(false);
  });
});
