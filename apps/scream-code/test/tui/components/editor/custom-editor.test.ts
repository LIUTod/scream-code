import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
} from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { getColorPalette } from '#/tui/theme/index';

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
    terminal: { rows: 24, cols: 80 },
  } as unknown as TUI;
  return new CustomEditor(tui, { ...getColorPalette('dark') });
}

async function flushAutocomplete(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function providerReturning(items: AutocompleteItem[]): AutocompleteProvider {
  return {
    getSuggestions: vi.fn(async () => ({ items, prefix: '/' })),
    applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
  };
}

describe('CustomEditor autocomplete Escape handling', () => {
  it('escape closes a visible slash command menu without firing app-level escape', async () => {
    const editor = makeEditor();
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    editor.setAutocompleteProvider(providerReturning([{ value: 'help', label: 'help' }]));

    editor.handleInput('/');
    await flushAutocomplete();

    expect(editor.isShowingAutocomplete()).toBe(true);

    editor.handleInput('');

    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('escape cancels an in-flight slash command menu request', async () => {
    const editor = makeEditor();
    const onEscape = vi.fn();
    let resolveSuggestions: (items: AutocompleteItem[]) => void = () => {};
    const provider: AutocompleteProvider = {
      getSuggestions: vi.fn(
        () =>
          new Promise<AutocompleteSuggestions | null>((resolve) => {
            resolveSuggestions = (items) =>{  resolve({ items, prefix: '/' }); };
          }),
      ),
      applyCompletion: vi.fn((lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol })),
    };
    editor.onEscape = onEscape;
    editor.setAutocompleteProvider(provider);

    editor.handleInput('/');
    await flushAutocomplete();
    editor.handleInput('');
    resolveSuggestions([{ value: 'help', label: 'help' }]);
    await flushAutocomplete();

    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('CustomEditor Kitty key release handling', () => {
  it('ignores Kitty key release events instead of inserting their CSI-u payload', () => {
    const editor = makeEditor();

    editor.handleInput('[47;1:3u');
    editor.handleInput('[110;1:3u');

    expect(editor.getText()).toBe('');
  });
});

describe('CustomEditor paste marker expansion', () => {
  const PASTE_START = '\u001B[200~';
  const PASTE_END = '\u001B[201~';

  function simulateLargePaste(editor: CustomEditor, content: string): void {
    editor.handleInput(`${PASTE_START}${content}${PASTE_END}`);
  }

  it('expands paste marker when bracketed paste arrives while cursor is on marker', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    expect(editor.getText()).toMatch(/\[paste #1 \+15 lines\]/);

    simulateLargePaste(editor, 'anything');

    expect(editor.getText()).not.toContain('[paste #');
    expect(editor.getText()).toContain(longText);
  });

  it('does not expand when cursor is not on a paste marker', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    editor.handleInput('hello');

    const textBefore = editor.getText();
    expect(textBefore).toContain('[paste #1');
    expect(textBefore).toContain('hello');

    const anotherLong = 'other\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, anotherLong);

    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getText()).toContain('[paste #2');
  });

  it('expands only the marker under cursor when multiple markers exist', () => {
    const editor = makeEditor();
    const text1 = 'first\n'.repeat(15).trimEnd();
    const text2 = 'second\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, text1);
    editor.handleInput(' ');
    simulateLargePaste(editor, text2);

    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getText()).toContain('[paste #2');

    // Position cursor on [paste #2 marker (col 21 = start of second marker).
    // Arrow keys skip over paste markers, so we set cursor position directly.
    (editor as any).state.cursorCol = 21;

    simulateLargePaste(editor, 'anything');

    // [paste #2 should be expanded (cursor was on it), [paste #1 should remain
    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getText()).not.toContain('[paste #2');
    expect(editor.getText()).toContain(text2);
  });

  it('handles Ctrl+V expansion when cursor is on marker', () => {
    const editor = makeEditor();
    editor.onPasteImage = vi.fn(async () => false);
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    expect(editor.getText()).toMatch(/\[paste #1/);

    editor.handleInput('\u0016');

    expect(editor.getText()).not.toContain('[paste #');
    expect(editor.getText()).toContain(longText);
  });

  it('restores marker text after undo but cannot re-expand (pastes map not restored)', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    expect(editor.getText()).toMatch(/\[paste #1/);

    simulateLargePaste(editor, 'anything');
    expect(editor.getText()).toContain(longText);

    // Undo restores the marker text but pi-tui 0.80.6+ does not restore
    // the pastes map, so the marker cannot be re-expanded.
    (editor as any).undo();

    expect(editor.getText()).toMatch(/\[paste #1/);

    // Re-expanding won't work because pastes map was cleared by the expansion
    simulateLargePaste(editor, 'anything');
    expect(editor.getText()).toContain('[paste #1');
  });

  it('suppresses multi-chunk bracketed paste data after marker expansion', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    editor.handleInput(`${PASTE_START}chunk1`);
    editor.handleInput(`chunk2${PASTE_END}`);

    expect(editor.getText()).not.toContain('chunk1');
    expect(editor.getText()).not.toContain('chunk2');
    expect(editor.getText()).toContain(longText);
  });

  it('handles paste-end sequence split across chunks', () => {
    const editor = makeEditor();
    const longText = 'line\n'.repeat(15).trimEnd();
    simulateLargePaste(editor, longText);

    // Split: PASTE_START in chunk 1, paste-end split across chunk 2 and 3
    editor.handleInput(`${PASTE_START}data`);
    editor.handleInput('\u001B[20');
    editor.handleInput('1~');

    expect(editor.getText()).toContain(longText);
    expect(editor.getText()).not.toContain('data');

    // Verify editor is not stuck — next keystrokes should work normally
    editor.handleInput('x');
    expect(editor.getText()).toContain('x');
  });
});


describe('CustomEditor think label', () => {
  it('embeds a "think" label in the top border when thinking is enabled', () => {
    const editor = makeEditor();
    editor.thinking = true;

    const out = editor.render(40).join('\n');

    expect(out).toContain('─ Think ─');
    // No longer uses box corners in the two-line flat design.
  });

  it('shows the thinking level next to the think label', () => {
    const editor = makeEditor();
    editor.thinking = true;
    editor.thinkingLevel = 'high';

    const out = editor.render(40).join('\n');

    expect(out).toContain('─ Think high ─');
  });

  it('hides the think label when thinking is disabled', () => {
    const editor = makeEditor();
    editor.thinking = false;

    const out = editor.render(40).join('\n');

    expect(out).not.toContain('─ Think ─');
  });

  it('does not try to embed the label when the terminal is too narrow', () => {
    const editor = makeEditor();
    editor.thinking = true;

    const out = editor.render(8).join('\n');

    expect(out).not.toContain('think');
  });
});
