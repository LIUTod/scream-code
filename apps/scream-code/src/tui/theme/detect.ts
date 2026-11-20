/**
 * Terminal background detection.
 *
 * Strategy, in priority order:
 *   1. Reject — non-TTY, NO_COLOR, FORCE_COLOR=0, CI → safe `'dark'`.
 *   2. OSC 11 — write `ESC ] 11 ; ? BEL`, parse `ESC ] 11 ; rgb:RR/GG/BB BEL`,
 *      compute relative luminance. Capped at `timeoutMs` so unsupported
 *      terminals don't hang.
 *   3. COLORFGBG — VT100 / xterm fallback exposing `"fg;bg"`.
 *   4. Default — `'dark'`.
 *
 * Must run before pi-tui enters raw mode; once the framework owns stdin
 * the OSC reply gets eaten by the input loop.
 */

import { OSC11_QUERY, TERMINAL_THEME_DETECT_TIMEOUT_MS } from "#/tui/constant/terminal";

import type { ResolvedTheme } from "./colors";
import { parseOsc11Background, type Osc11Background } from "./terminal-background";

export interface TerminalThemeDetection {
  readonly theme: ResolvedTheme;
  /** The terminal's background (`#rrggbb`); absent unless OSC 11 answered. */
  readonly hex?: string;
}

export interface DetectOptions {
  readonly timeoutMs?: number;
}

/**
 * What the terminal told us about itself: the mode always, the ground when the
 * terminal answers OSC 11.
 *
 * One function for both, because the startup path needs the pair and two calls
 * would query the terminal twice. The exact colour is what lets a surface move
 * away from the ground the terminal actually paints (see `code-surface.ts`);
 * `hex` is absent when only `COLORFGBG` or the `dark` default was available,
 * and callers then use the tuned fallback surface.
 */
export async function detectTerminalTheme(
  opts: DetectOptions = {},
): Promise<TerminalThemeDetection> {
  if (!isInteractiveTerminal()) return { theme: "dark" };
  if (isColorOptOut()) return { theme: "dark" };

  const fromOsc = await queryOsc11({
    timeoutMs: opts.timeoutMs ?? TERMINAL_THEME_DETECT_TIMEOUT_MS,
  });
  if (fromOsc !== null) return { theme: fromOsc.theme, hex: fromOsc.hex };

  // Terminals that ignore OSC 11 still report a 16-colour index here; keeping
  // this step is what stops a light-background terminal (rxvt, a blocked reply)
  // from silently resolving to the dark palette.
  const fromColorFgBg = parseColorFgBg(process.env["COLORFGBG"]);
  return fromColorFgBg === null ? { theme: "dark" } : { theme: fromColorFgBg };
}

function isInteractiveTerminal(): boolean {
  return (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
}

function isColorOptOut(): boolean {
  const env = process.env;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return true;
  if (env["FORCE_COLOR"] === "0") return true;
  if (env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "0") return true;
  return false;
}

interface RawModeStdin {
  isRaw?: boolean;
  setRawMode(mode: boolean): NodeJS.ReadStream;
  on(event: "data", listener: (data: Buffer) => void): NodeJS.ReadStream;
  off(event: "data", listener: (data: Buffer) => void): NodeJS.ReadStream;
}

async function queryOsc11(opts: { timeoutMs: number }): Promise<Osc11Background | null> {
  const stdin = process.stdin as unknown as RawModeStdin;
  if (typeof stdin.setRawMode !== "function") return null;
  // If something else is already listening on stdin (e.g. another raw-mode
  // consumer), don't fight for it — punt to COLORFGBG instead.
  if (process.stdin.listenerCount("data") > 0) return null;

  const wasRaw = stdin.isRaw === true;
  let buffer = "";
  let listener: ((data: Buffer) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    if (!wasRaw) stdin.setRawMode(true);

    const result = await new Promise<Osc11Background | null>((resolve) => {
      listener = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        const background = parseOsc11Background(buffer);
        if (background !== null) resolve(background);
      };
      stdin.on("data", listener);
      timer = setTimeout(() => {
        resolve(null);
      }, opts.timeoutMs);
      try {
        process.stdout.write(OSC11_QUERY);
      } catch {
        resolve(null);
      }
    });

    return result;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (listener !== null) stdin.off("data", listener);
    if (!wasRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore — raw mode restoration best-effort */
      }
    }
  }
}

/**
 * COLORFGBG is `"fg;bg"` (sometimes `"fg;default;bg"`). The last token is
 * the background ANSI 16-color index; 0–6 and 8 are dark, the rest light.
 */
export function parseColorFgBg(value: string | undefined): ResolvedTheme | null {
  if (value === undefined || value === "") return null;
  const parts = value.split(";");
  const bgRaw = parts.at(-1);
  if (bgRaw === undefined) return null;
  const bg = parseInt(bgRaw, 10);
  if (!Number.isInteger(bg)) return null;
  // ANSI 0=black, 1=red, 2=green, 3=yellow, 4=blue, 5=magenta, 6=cyan, 8=bright black.
  const darkBgs = new Set([0, 1, 2, 3, 4, 5, 6, 8]);
  return darkBgs.has(bg) ? "dark" : "light";
}
