import process from "node:process";
const { stdout } = process;

import type { ResolvedTheme } from "#/tui/theme/colors";

const DIM = "\x1b[38;2;136;136;136m";
const BRIGHT = "\x1b[38;2;255;255;255m";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const THEME_GREEN: Record<ResolvedTheme, string> = {
  dark: "\x1b[38;2;78;200;126m",   // #4EC87E
  light: "\x1b[38;2;14;122;56m",  // #0E7A38
};

const FRAMES = [
  { duration: 80, content: ["┌┐", "││", "││", "└┘"] },
  { duration: 80, content: ["┌──────┐", "│      │", "│      │", "└──────┘"] },
  { duration: 80, content: ["┌──────────────────┐", "│                  │", "│                  │", "└──────────────────┘"] },
  {
    duration: 80,
    content: [
      "┌──────────────────────────────┐",
      "│                              │",
      "│    welcome to scream code    │",
      "│                              │",
      "└──────────────────────────────┘",
    ],
  },
  {
    duration: 100,
    content: [
      "┌─────────────────────────────────────────────────────────────────┐",
      "│                                                                 │",
      "│                     welcome to scream code                      │",
      "│                                                                 │",
      "│      ███████╗  ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗       │",
      "│      ██╔════╝ ██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║       │",
      "│      ███████╗ ██║     ██████╔╝█████╗  ███████║██╔████╔██║       │",
      "│      ╚════██║ ██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║       │",
      "│      ███████║ ╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║       │",
      "│      ╚══════╝  ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝       │",
      "│                                                                 │",
      "└─────────────────────────────────────────────────────────────────┘",
    ],
  },
  {
    duration: 120,
    content: [
      "┌─────────────────────────────────────────────────────────────────┐",
      "│                                                                 │",
      "│                     welcome to scream code                      │",
      "│                                                                 │",
      "│      ███████╗  ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗       │",
      "│      ██╔════╝ ██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║       │",
      "│      ███████╗ ██║     ██████╔╝█████╗  ███████║██╔████╔██║       │",
      "│      ╚════██║ ██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║       │",
      "│      ███████║ ╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║       │",
      "│      ╚══════╝  ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝       │",
      "│                                                                 │",
      "│                       你的中文智能Ai助手                        │",
      "└─────────────────────────────────────────────────────────────────┘",
    ],
  },
  {
    duration: 9999,
    content: [
      "┌─────────────────────────────────────────────────────────────────┐",
      "│                                                                 │",
      "│                     welcome to scream code                      │",
      "│                                                                 │",
      "│      ███████╗  ██████╗██████╗ ███████╗ █████╗ ███╗   ███╗       │",
      "│      ██╔════╝ ██╔════╝██╔══██╗██╔════╝██╔══██╗████╗ ████║       │",
      "│      ███████╗ ██║     ██████╔╝█████╗  ███████║██╔████╔██║       │",
      "│      ╚════██║ ██║     ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║       │",
      "│      ███████║ ╚██████╗██║  ██║███████╗██║  ██║██║ ╚═╝ ██║       │",
      "│      ╚══════╝  ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝       │",
      "│                                                                 │",
      "│                       你的中文智能Ai助手                        │",
      "└─────────────────────────────────────────────────────────────────┘",
    ],
  },
];

function color(line: string, green: string): string {
  const s = line.replace(/[│ ]/g, "");
  const tb = (line.startsWith("┌") || line.startsWith("└")) && (line.endsWith("┐") || line.endsWith("┘")) && s.replace(/[─┌┐└┘]/g, "") === "";
  const es = line.startsWith("│") && line.endsWith("│") && s === "";
  if (tb || es) return green;
  if (line.includes("welcome") || line.includes("scream") || line.includes("你的中文")) return green;
  return BRIGHT;
}

let ansiSupported: boolean | null = null;

function supportsAnsi(): boolean {
  if (ansiSupported !== null) return ansiSupported;

  // Non-TTY (pipe, redirect, headless) — no cursor control possible
  if (!stdout.isTTY) {
    ansiSupported = false;
    return false;
  }

  // Respect NO_COLOR / FORCE_COLOR conventions
  if (process.env.NO_COLOR) {
    ansiSupported = false;
    return false;
  }
  if (process.env.FORCE_COLOR) {
    ansiSupported = true;
    return true;
  }

  // Windows: Terminal / conhost on Win10 1909+ supports ANSI.
  // CI environments (gh actions, appveyor) set CI=true.
  if (process.platform === 'win32') {
    const term = (process.env.TERM ?? '').toLowerCase();
    const session = (process.env.TERM_PROGRAM ?? '').toLowerCase();
    // Windows Terminal, ConEmu, Cmder all support ANSI
    if (term.includes('xterm') || term.includes('vt100') || term.includes('256color')) {
      ansiSupported = true;
      return true;
    }
    if (session.includes('terminal') || session.includes('vscode')) {
      ansiSupported = true;
      return true;
    }
    // GitHub Actions / CI on Windows
    if (process.env.CI) {
      ansiSupported = true;
      return true;
    }
    // Last resort: Win10 build 1909+ enables ANSI by default via conhost
    // Node >=22 on Win10+ should have it. Assume yes but guard with simple test.
    ansiSupported = true;
    return true;
  }

  // Unix: check TERM
  if (process.env.TERM && process.env.TERM !== 'dumb') {
    ansiSupported = true;
    return true;
  }

  ansiSupported = false;
  return false;
}

function plainFrame(frameIndex: number, green: string): string {
  const f = FRAMES[Math.min(frameIndex, FRAMES.length - 1)];
  let out = '';
  for (const l of f.content) {
    out += color(l, green) + (l || ' ') + RESET + '\n';
  }
  return out;
}

export function runLoadingAnimation(theme: ResolvedTheme = 'dark'): Promise<void> {
  const green = THEME_GREEN[theme];
  const ansi = supportsAnsi();

  // Non-TTY or no ANSI: just print the final frame once, then resolve
  if (!ansi) {
    stdout.write(plainFrame(FRAMES.length - 1, green));
    stdout.write('\n' + DIM + '正在加载scream code....' + RESET + '\n');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const last = FRAMES.length - 1;
    let frame = 0;

    function draw(i: number) {
      stdout.write('\x1b[H' + plainFrame(i, green));
    }

    function tick() {
      if (frame >= last) {
        setTimeout(() => {
          stdout.write('\n' + DIM + '正在加载scream code....' + RESET + '\n');
          setTimeout(() => {
            stdout.write('\x1b[2J\x1b[H' + SHOW_CURSOR);
            resolve();
          }, 400);
        }, 600);
        return;
      }
      draw(frame);
      frame++;
      setTimeout(tick, FRAMES[frame - 1].duration);
    }

    stdout.write(HIDE_CURSOR + '\x1b[2J\x1b[H');
    draw(0);
    setTimeout(tick, FRAMES[0].duration);
  });
}
