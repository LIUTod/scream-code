/**
 * Custom editor extending pi-tui Editor with app-level keybindings.
 */

import { Editor, isKeyRelease, matchesKey, Key, visibleWidth, type TUI } from '@liutod-scream/pi-tui';
import type { PermissionMode, ThinkingEffort } from '@scream-code/scream-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import { createEditorTheme } from '#/tui/theme/pi-tui-theme';

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const ANSI_SGR = /\[[0-9;]*m/g;

const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const BRACKET_PASTE_START = '[200~';
const BRACKET_PASTE_END = '[201~';

const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;
const BRACKETED_IMAGE_PATH_BOUNDARY_REGEX = /\.(?:png|jpe?g|gif|webp)(?=$|["']?\s)/gi;
const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;

function isPastedPathSeparator(char: string | undefined): boolean {
  return char === undefined || char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function imagePathBoundaryEnd(payload: string, segmentStart: number, extensionEnd: number): number | undefined {
  const quote = payload[segmentStart];
  const afterExtension = payload[extensionEnd];
  if (quote === '"' || quote === "'") {
    return afterExtension === quote && isPastedPathSeparator(payload[extensionEnd + 1])
      ? extensionEnd + 1
      : undefined;
  }
  if (isPastedPathSeparator(afterExtension)) return extensionEnd;
  return undefined;
}

function normalizePastedImagePath(path: string): string {
  const trimmed = path.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const unquoted =
    trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(SHELL_ESCAPED_PATH_CHAR_REGEX, '$1');
}

/**
 * If a bracketed paste contains only image file paths (one or more,
 * space/quote separated, all with image extensions), return them. Returns
 * `undefined` when the paste is mixed text + paths or contains non-image
 * content — in that case the caller should fall through to normal text
 * paste. Mirrors oh-my-pi's approach so pasting a Finder-copied image
 * file becomes a multimodal image attachment instead of a text path the
 * agent would have to Read manually.
 */
function extractBracketedImagePastePaths(data: string): string[] | undefined {
  if (!data.includes(BRACKET_PASTE_START)) return undefined;
  const startIndex = data.indexOf(BRACKET_PASTE_START);
  const endIndex = data.indexOf(BRACKET_PASTE_END, startIndex + BRACKET_PASTE_START.length);
  if (endIndex === -1) return undefined;
  const pasted = data.slice(startIndex + BRACKET_PASTE_START.length, endIndex).trim();
  if (pasted.length === 0) return undefined;

  const paths: string[] = [];
  let segmentStart = 0;
  BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.lastIndex = 0;
  for (
    let match = BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.exec(pasted);
    match !== null;
    match = BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.exec(pasted)
  ) {
    const extensionEnd = match.index + match[0].length;
    const boundaryEnd = imagePathBoundaryEnd(pasted, segmentStart, extensionEnd);
    if (boundaryEnd === undefined) continue;

    const path = normalizePastedImagePath(pasted.slice(segmentStart, boundaryEnd));
    if (path.length === 0 || !BRACKETED_IMAGE_PATH_REGEX.test(path)) return undefined;
    paths.push(path);

    segmentStart = boundaryEnd;
    while (segmentStart < pasted.length && isPastedPathSeparator(pasted[segmentStart])) {
      segmentStart += 1;
    }
    BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.lastIndex = segmentStart;
  }

  if (paths.length === 0 || segmentStart !== pasted.length) return undefined;
  return paths;
}

// Kitty keyboard protocol CSI-u sequence: ESC [ keycode ; modifier[:eventType] u.
// We intentionally match only the simple two-field form — enough to rewrite
// `ctrl+<LETTER>` with caps_lock into `ctrl+<letter>` without caps_lock.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match CSI
const KITTY_CSI_U = /^\[(\d+);(\d+)((?::\d+)*)u$/;
// Kitty modifier bit layout: shift=1, alt=2, ctrl=4, super=8, hyper=16,
// meta=32, caps_lock=64, num_lock=128. Reported value is `mask + 1`.
const CAPS_LOCK_BIT = 64;
const CTRL_BIT = 4;
const SHIFT_BIT = 1;

interface AutocompleteInternals {
  cancelAutocomplete(): void;
  readonly autocompleteAbort?: AbortController;
  readonly autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Workaround for a pi-tui bug that surfaces when Kitty keyboard protocol
 * is active AND caps_lock is on. In that state terminals emit, e.g.,
 * `ESC[68;69u` for ctrl+d (codepoint=68=`D`, modifier=ctrl|caps_lock).
 * pi-tui's `matchesKittySequence` masks `caps_lock` out of the *modifier*
 * but leaves the *codepoint* capitalised, so `matchesKey(data, "ctrl+d")`
 * (which expects codepoint=100=`d`) fails and every ctrl-shortcut is
 * silently dropped.
 *
 * We rewrite the sequence back to its unlocked form before dispatching,
 * but only when ctrl is held and shift is not — i.e. exactly the
 * `ctrl+<letter>` case. Plain uppercase (caps_lock only, no ctrl) and
 * explicit ctrl+shift+<letter> are left alone.
 */
export function normalizeCapsLockedCtrl(data: string): string {
  const m = data.match(KITTY_CSI_U);
  if (m === null) return data;
  const codepoint = Number(m[1]);
  const modifierPlus1 = Number(m[2]);
  const tail = m[3] ?? '';
  if (!Number.isFinite(codepoint) || !Number.isFinite(modifierPlus1)) return data;
  const modifier = modifierPlus1 - 1;
  if ((modifier & CAPS_LOCK_BIT) === 0) return data;
  if ((modifier & CTRL_BIT) === 0) return data;
  if ((modifier & SHIFT_BIT) !== 0) return data;
  if (codepoint < 65 || codepoint > 90) return data;
  const loweredCodepoint = codepoint + 32;
  const strippedModifier = (modifier & ~CAPS_LOCK_BIT) + 1;
  return `[${String(loweredCodepoint)};${String(strippedModifier)}${tail}u`;
}

/** Convert a visible-char index (ANSI-stripped) back to an index into the raw ANSI-bearing string. */
function mapVisibleIdxToRaw(line: string, visibleIdx: number): number {
  let visibleCount = 0;
  let i = 0;
  const re = new RegExp(ANSI_SGR.source, 'y');
  while (i < line.length && visibleCount < visibleIdx) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m !== null && m.index === i) {
      i += m[0].length;
    } else {
      visibleCount++;
      i++;
    }
  }
  return i;
}

function stripSgr(s: string): string {
  return s.replace(ANSI_SGR, '');
}

function getNewlineInput(data: string): string | undefined {
  if (data === '\n' || data === '\r' || data === '[13;2~') return data;
  if (matchesKey(data, Key.ctrl('j'))) return '\n';
  return undefined;
}

export class CustomEditor extends Editor {
  public onEscape?: () => void;
  public onCtrlD?: () => void;
  public onCtrlC?: () => void;
  public onToggleToolExpand?: () => void;
  // Returns true when a plan card actually handled the toggle. When it
  // returns false (no plan in the transcript) the keystroke falls through
  // to pi-tui's default ctrl+e binding (move cursor to end of line).
  public onTogglePlanExpand?: () => boolean;
  public onOpenExternalEditor?: () => void;
  public onCtrlS?: () => void;
  public onCtrlW?: () => void;
  /**
   * Called when ↑ is pressed in an empty editor. Return `true` to consume
   * the key (e.g. recalled a queued message); return `false` to fall
   * through so pi-tui's built-in history navigation runs.
   */
  public onUpArrowEmpty?: () => boolean;
  public onShiftTab?: () => void;
  /**
   * Called when the user triggers "paste image" (Ctrl-V on Unix,
   * Alt-V on Windows — Ctrl-V is terminal-reserved there). Return
   * `true` to consume the key (image was read and handled); return
   * `false` to let the key fall through to the normal paste path.
   * The callback may be async; pi-tui awaits it before dispatching
   * the next keystroke.
   */
  public onPasteImage?: () => Promise<boolean>;
  /**
   * Called when a bracketed paste contains only image file paths (e.g.
   * the user copied an image file in Finder and pasted — the terminal
   * translates the file URL into a text path). The host loads each path
   * from disk and registers it as an image attachment, so the paste
   * becomes a multimodal image input instead of a text path the agent
   * would have to Read manually.
   */
  public onPasteImagePath?: (path: string) => void | Promise<void>;
  /** Fires exactly once when the user first types anything into the editor. */
  public onFirstInput?: () => void;
  private firstInputFired = false;

  /** Whether the user has ever typed anything into the editor. */
  hasFirstInputFired(): boolean {
    return this.firstInputFired;
  }

  /** Reset the first-input gate so onFirstInput will fire again on the next keystroke. */
  resetFirstInputGate(): void {
    this.firstInputFired = false;
  }

  /** Whether the active model has thinking enabled. When true, a small "think" label is embedded in the top-right of the input box border. */
  thinking = false;
  /** Current thinking effort level (e.g. low, medium, high). Used to annotate the think label. */
  thinkingLevel: ThinkingEffort = 'off';
  /** Current permission mode — always shown as a badge at the top-left of the input box border. */
  permissionMode: PermissionMode = 'manual';
  /** Current border colour hex — kept in sync with borderColor by the host. */
  borderHex = '';

  private consumingPaste = false;
  private consumeBuffer = '';

  /**
   * `colors` is the live `ColorPalette` reference — the host mutates it
   * in place on theme switch (`Object.assign(state.theme.colors, ...)`), so
   * reading `this.colors.<token>` at render time always sees the
   * current theme without any setter plumbing. The `EditorTheme` that
   * pi-tui's `Editor` requires is derived from the same palette, and
   * `paddingX: 2` reserves the two leading columns where `render()`
   * paints the terminal-style `> ` prompt — both are implementation
   * details, not caller knobs.
   */
  constructor(
    tui: TUI,
    private readonly colors: ColorPalette,
  ) {
    // paddingX: 2 reserves two leading columns for the `> ` prompt symbol.
    super(tui, createEditorTheme(colors), { paddingX: 2 });
  }

  private expandPasteMarkerAtCursor(): boolean {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const currentLine = lines[line] ?? '';

    for (const match of currentLine.matchAll(PASTE_MARKER_RE)) {
      const start = match.index;
      const end = start + match[0].length;
      if (col < start || col > end) continue;

      const pasteId = Number(match[1]);
      const pastes = (this as unknown as { pastes: Map<number, string> }).pastes;
      const content = pastes.get(pasteId);
      if (content === undefined) return false;

      const text = this.getText();
      const offset = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + start;
      const newText = text.slice(0, offset) + content + text.slice(offset + match[0].length);
      this.setText(newText);
      return true;
    }
    return false;
  }

  private hasAutocompleteActivity(): boolean {
    const autocomplete = this as unknown as AutocompleteInternals;
    return (
      this.isShowingAutocomplete() ||
      autocomplete.autocompleteAbort !== undefined ||
      autocomplete.autocompleteDebounceTimer !== undefined
    );
  }

  private cancelAutocompleteActivity(): void {
    // pi-tui exposes `isShowingAutocomplete()` but keeps cancellation private.
    // Scream needs Esc to win over app-level cancel while the slash menu request is active.
    (this as unknown as AutocompleteInternals).cancelAutocomplete();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;
    const firstContentIdx = 1;
    const text = this.getText().trimStart();
    if (text.startsWith('/')) {
      // Paint only the FIRST editor content line; multi-line slash commands
      // are not a thing in practice.
      const original = lines[firstContentIdx];
      if (original !== undefined) {
        const highlighted = highlightFirstSlashToken(original, this.colors.primary);
        if (highlighted !== undefined) {
          lines[firstContentIdx] = highlighted;
        }
      }
    }
    const firstContent = lines[firstContentIdx];
    if (firstContent !== undefined) {
      const withPrompt = injectPromptSymbol(firstContent);
      if (withPrompt !== undefined) {
        lines[firstContentIdx] = withPrompt;
      }
    }
    injectBorderBadges(lines, width, {
      mode: this.permissionMode,
      thinking: this.thinking,
      thinkingLevel: this.thinkingLevel,
      paint: this.borderColor ?? ((s: string) => s),
      borderHex: this.borderHex,
    });
    return lines;
  }

  override handleInput(data: string): void {
    const normalized = normalizeCapsLockedCtrl(data);
    if (isKeyRelease(normalized)) {
      return;
    }

    // When a paste marker was just expanded, discard the trailing bracketed
    // paste data that the terminal sends alongside the Ctrl-V keystroke.
    if (this.consumingPaste) {
      this.consumeBuffer += normalized;
      if (this.consumeBuffer.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = false;
        this.consumeBuffer = '';
      }
      return;
    }

    // If a bracketed paste arrives while the cursor sits on an existing
    // paste marker, expand that marker instead of pasting new content.
    if (normalized.includes(BRACKET_PASTE_START) && this.expandPasteMarkerAtCursor()) {
      if (!normalized.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = true;
      }
      return;
    }

    // Pasting a copied image file (e.g. from Finder): the terminal
    // translates the file URL into a text path. When the bracketed paste
    // contains only image file paths, load each from disk as an image
    // attachment instead of inserting the path as text — so the paste
    // becomes a multimodal image input the model sees directly, not a
    // text path the agent would have to Read manually.
    const pastedImagePaths = extractBracketedImagePastePaths(normalized);
    if (pastedImagePaths !== undefined && this.onPasteImagePath !== undefined) {
      const handler = this.onPasteImagePath;
      void (async () => {
        for (const path of pastedImagePaths) {
          await handler(path);
        }
      })();
      if (!normalized.includes(BRACKET_PASTE_END)) {
        this.consumingPaste = true;
      }
      return;
    }

    // Paste image binding — platform-aware:
    //   Windows terminals reserve Ctrl-V for their own paste handling
    //   (e.g. Windows Terminal's Ctrl+V shortcut), so we listen for
    //   Alt-V there. Everywhere else Ctrl-V pastes. When the host
    //   reports no image available, we fall through to pi-tui's
    //   normal paste path so text from the clipboard still works.
    const pasteKey = process.platform === 'win32' ? 'alt+v' : Key.ctrl('v');
    if (matchesKey(normalized, pasteKey)) {
      if (this.expandPasteMarkerAtCursor()) {
        return;
      }
      if (this.onPasteImage !== undefined) {
        const handler = this.onPasteImage;
        void handler().then((handled) => {
          if (!handled) {
            super.handleInput.call(this, normalized);
          }
        });
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl('d'))) {
      if (this.getText().length === 0) {
        this.onCtrlD?.();
        return;
      }
    }

    if (matchesKey(normalized, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('g'))) {
      this.onOpenExternalEditor?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('o'))) {
      this.onToggleToolExpand?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('e'))) {
      if (this.onTogglePlanExpand?.() === true) return;
      // No plan to toggle — fall through to pi-tui's end-of-line.
    }

    if (matchesKey(normalized, Key.ctrl('s'))) {
      this.onCtrlS?.();
      return;
    }

    if (matchesKey(normalized, Key.ctrl('w'))) {
      this.onCtrlW?.();
      return;
    }

    if (matchesKey(normalized, 'shift+tab')) {
      this.onShiftTab?.();
      return;
    }

    const newlineInput = getNewlineInput(normalized);
    if (newlineInput !== undefined) {
      super.handleInput(newlineInput);
      return;
    }

    if (matchesKey(normalized, Key.up)) {
      if (this.getText().length === 0 && this.onUpArrowEmpty) {
        if (this.onUpArrowEmpty()) return;
        // fall through to super so Editor's built-in history navigation runs
      }
    }

    if (matchesKey(normalized, Key.escape)) {
      if (this.hasAutocompleteActivity()) {
        this.cancelAutocompleteActivity();
        return;
      }
      this.onEscape?.();
      return;
    }

    if (!this.firstInputFired) {
      this.firstInputFired = true;
      this.onFirstInput?.();
    }

    super.handleInput(normalized);
  }
}

/**
 * Return a copy of `line` with the first `/token` coloured using `hex`.
 * `line` may already contain SGR escapes (cursor inverse, etc.); we
 * locate `/` via visible-index math so ANSI pass-through survives.
 * Returns `undefined` if no token is found.
 */
export function highlightFirstSlashToken(line: string, hex: string): string | undefined {
  const visible = stripSgr(line);
  const slashIdx = visible.indexOf('/');
  if (slashIdx < 0) return undefined;
  // Guard: only paint when `/` is the first non-whitespace character
  // on the line (avoids colouring a mid-sentence slash).
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== ' ' && visible[i] !== '\t') return undefined;
  }
  // Token ends at the next whitespace (or the visible end).
  let endVisible = slashIdx + 1;
  while (endVisible < visible.length) {
    const ch = visible[endVisible];
    if (ch === ' ' || ch === '\t') break;
    endVisible++;
  }
  const visibleToken = visible.slice(slashIdx, endVisible);
  if (visibleToken.slice(1).includes('/')) return undefined;
  const rawStart = mapVisibleIdxToRaw(line, slashIdx);
  const rawEnd = mapVisibleIdxToRaw(line, endVisible);
  const before = line.slice(0, rawStart);
  const token = line.slice(rawStart, rawEnd);
  const after = line.slice(rawEnd);
  return before + chalk.hex(hex).bold(token) + after;
}

/**
 * Overlay a terminal-style `> ` prompt symbol on the first content line.
 * Relies on the editor being configured with `paddingX >= 2` so the line
 * starts with at least two literal spaces. Emits no SGR so the terminal's
 * default foreground colour renders the symbol. Returns `undefined` if the
 * line is too short or doesn't begin with the expected padding.
 */
export function injectPromptSymbol(line: string): string | undefined {
  if (line.length < 2) return undefined;
  for (let i = 0; i < 2; i++) {
    if (line[i] !== ' ') return undefined;
  }
  return '> ' + line.slice(2);
}

/**
 * Post-process pi-tui's editor output to draw a full box around it.
 *
 * pi-tui only renders horizontal top/bottom borders; we wrap them with
 * `╭╮╰╯` corners and add vertical `│` bars on each row's outer columns.
 * Horizontal-border rows (those whose first visible char is `─`, including
 * scroll indicators like `── ↑ N more ──`) are stripped of their existing
 * SGR and repainted as a single box-drawn span. Content rows keep their
 * inner SGR intact; only column 0 and the last column are overlaid, and
 * only if they're literal spaces — that protects the cursor-overflow
 * case where the rightmost column is an SGR-tagged inverse cursor.
 */
export function wrapWithSideBorders(
  lines: string[],
  paint: (s: string) => string,
): string[] {
  let seenTop = false;
  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === '─') {
      const leftCorner = seenTop ? '╰' : '╭';
      const rightCorner = seenTop ? '╯' : '╮';
      seenTop = true;
      if (plain.length === 1) return paint(leftCorner);
      const middle = plain.slice(1, -1);
      return paint(leftCorner + middle + rightCorner);
    }
    if (line.length === 0) return line;
    const firstCh = line[0];
    const lastCh = line.at(-1);
    const head = firstCh === ' ' ? paint('│') : (firstCh ?? '');
    const tail =
      line.length > 1 && lastCh === ' ' ? paint('│') : (lastCh ?? '');
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}

const THINK_LABEL_MIN_WIDTH = 14;
const MODE_BADGE_MIN_WIDTH = 10;

function isLightBg(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

function makeBadge(label: string, bgHex: string): string {
  return bgHex
    ? chalk.bgHex(bgHex).hex(isLightBg(bgHex) ? '#000000' : '#FFFFFF')(label)
    : chalk.bgBlack.white(label);
}

interface BorderBadgeOptions {
  mode: PermissionMode;
  thinking: boolean;
  thinkingLevel: ThinkingEffort;
  paint: (s: string) => string;
  borderHex: string;
}

/**
 * Compose the editor's top border line with up to two badges: the
 * permission mode badge at the left (always shown) and the think badge at
 * the right (only when thinking is enabled). Each badge is a solid colour
 * block with black/white text picked by background luminance. When the
 * editor is scrolled, pi-tui's `↑ N more` indicator keeps the line — it
 * signals hidden content, which matters more than the badges. On narrow
 * terminals the think badge drops first, then the mode badge.
 */
function injectBorderBadges(lines: string[], width: number, opts: BorderBadgeOptions): void {
  const topIdx = lines.findIndex((line) => {
    const plain = stripSgr(line);
    return plain.length > 0 && plain[0] === '─';
  });
  if (topIdx === -1) return;
  // Scrolled editor: keep the "↑ N more" indicator instead of the badges.
  if (stripSgr(lines[topIdx]!).includes('↑')) return;

  const { paint } = opts;
  let left = '';
  let right = paint('─');

  if (width >= MODE_BADGE_MIN_WIDTH) {
    // Mode labels stay in English across locales: they are mode names, not
    // prose. The badge takes the border's own colour (fluorescent green by
    // default) so it always matches the input box; bold keeps it readable
    // against the surrounding dashes.
    const badgeText = ` ${opts.mode} `;
    left =
      paint('──') + (opts.borderHex ? chalk.hex(opts.borderHex).bold(badgeText) : paint(badgeText));
  }
  if (opts.thinking && width >= THINK_LABEL_MIN_WIDTH) {
    const label = opts.thinkingLevel !== 'off' ? ` Think ${opts.thinkingLevel} ` : ' Think ';
    right = makeBadge(label, opts.borderHex) + paint('─');
  }

  const fill = width - visibleWidth(left) - visibleWidth(right);
  if (fill < 0) {
    // Both badges together overflow: keep the mode badge only.
    const modeOnlyFill = width - visibleWidth(left) - 1;
    lines[topIdx] = modeOnlyFill >= 0 ? left + paint('─'.repeat(modeOnlyFill)) + paint('─') : paint('─'.repeat(width));
    return;
  }
  lines[topIdx] = left + paint('─'.repeat(fill)) + right;
}
