/**
 * agent-desktop MCP Server
 *
 * Stdio MCP server that wraps the agent-desktop native binary.  Exposes
 * 12 computer_* tools — one per agent-desktop subcommand — and translates
 * between MCP JSON-RPC and the binary's CLI/JSON interface.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// ── Tool input schemas (Zod) ───────────────────────────────────────────

const ComputerSnapshotInputSchema = z.object({
  app: z.string().optional(),
  window_id: z.string().optional(),
  interactive_only: z.boolean().optional(),
  include_bounds: z.boolean().optional(),
  compact: z.boolean().optional(),
  max_depth: z.number().optional(),
  surface: z.string().optional(),
});

const ComputerScreenshotInputSchema = z.object({
  output_path: z.string().optional(),
  app: z.string().optional(),
  window_id: z.string().optional(),
});

const ComputerClickInputSchema = z.object({
  ref: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  count: z.enum(['single', 'double', 'triple']).optional(),
});

const ComputerMouseMoveInputSchema = z.object({
  ref: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  duration_ms: z.number().optional(),
});

const ComputerTypeInputSchema = z.object({
  ref: z.string(),
  text: z.string(),
});

const ComputerPressInputSchema = z.object({
  key: z.string(),
  app: z.string().optional(),
});

const ComputerScrollInputSchema = z.object({
  ref: z.string(),
  direction: z.enum(['left', 'right', 'up', 'down']),
  amount: z.number().optional(),
});

const ComputerLaunchInputSchema = z.object({
  app: z.string(),
  timeout_ms: z.number().optional(),
});

const ComputerListWindowsInputSchema = z.object({
  app: z.string().optional(),
});

const ComputerFocusWindowInputSchema = z.object({
  window_id: z.string().optional(),
  app: z.string().optional(),
  title: z.string().optional(),
});

const ComputerGetInputSchema = z.object({
  ref: z.string(),
  property: z.enum(['text', 'role', 'value', 'title', 'bounds', 'states']).optional(),
});

const ComputerWaitInputSchema = z.object({
  milliseconds: z.number().optional(),
  element: z.string().optional(),
  window: z.string().optional(),
  text: z.string().optional(),
  timeout_ms: z.number().optional(),
  menu_open: z.string().optional(),
  menu_closed: z.string().optional(),
});

// ── Binary resolution ──────────────────────────────────────────────────

interface AgentDesktopInvoker {
  command: string;
  prefixArgs: string[];
  available: boolean;
}

function resolveAgentDesktopInvoker(): AgentDesktopInvoker {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('agent-desktop/package.json');
    const jsPath = join(dirname(packagePath), 'bin', 'agent-desktop.js');
    return { command: process.execPath, prefixArgs: [jsPath], available: true };
  } catch {
    // Global install: binary is on PATH even though createRequire can't see it.
    return { command: 'agent-desktop', prefixArgs: [], available: true };
  }
}

// ── Environment allowlist ──────────────────────────────────────────────

const ENV_ALLOWLIST = [
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH',
  'SHELL', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'TMP', 'TMPDIR', 'TEMP', 'USER', '__CF_USER_TEXT_ENCODING',
];

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = { FORCE_COLOR: '0' };
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// ── Runner ─────────────────────────────────────────────────────────────

interface RunResult {
  success: boolean;
  data: unknown;
  error?: string;
}

function runDesktop(args: string[]): Promise<RunResult> {
  const invoker = resolveAgentDesktopInvoker();
  return new Promise((resolve) => {
    execFile(
      invoker.command,
      [...invoker.prefixArgs, ...args],
      { env: buildEnv(), maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        // Try parsing JSON output even on failure — agent-desktop writes
        // structured errors to stdout.
        if (stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim());
            if (parsed && typeof parsed === 'object') {
              resolve({
                success: parsed.ok === true && !error,
                data: parsed,
                error: !parsed.ok ? (parsed.error?.message ?? JSON.stringify(parsed.error)) : error?.message,
              });
              return;
            }
          } catch { /* fall through */ }
        }
        if (error) {
          const detail = stderr?.trim() || error.message;
          resolve({ success: false, data: null, error: detail });
          return;
        }
        resolve({ success: true, data: stdout.trim() });
      },
    );
  });
}

function formatError(result: RunResult): string {
  if (!result.error) return 'Unknown agent-desktop error';
  const lower = result.error.toLowerCase();
  if (lower.includes('accessibility'))
    return `${result.error}\nEnable Accessibility permission for your terminal in System Settings > Privacy & Security > Accessibility.`;
  if (lower.includes('supports macos only') || lower.includes('macos only'))
    return `${result.error}\nagent-desktop supports macOS only.`;
  return result.error;
}

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

function macOnlyError(): string {
  return 'Desktop automation is only available on macOS. agent-desktop does not support this platform.';
}

// ── Argument mapping ───────────────────────────────────────────────────

interface ArgMapping {
  /** Positional argument field names, in order. */
  positional?: string[];
  /** Map input field names → CLI flag names (without -- prefix). */
  flags?: Record<string, string>;
}

function buildCliArgs(
  subcommand: string,
  input: Record<string, unknown>,
  mapping: ArgMapping,
): string[] {
  const args = [subcommand];
  if (mapping.positional) {
    for (const key of mapping.positional) {
      const value = input[key];
      if (value !== undefined && value !== null) args.push(String(value));
    }
  }
  if (mapping.flags) {
    for (const [key, flagName] of Object.entries(mapping.flags)) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean') {
        if (value) args.push('--' + flagName);
      } else {
        args.push('--' + flagName, String(value));
      }
    }
  }
  return args;
}

// ── Server setup ───────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'agent-desktop', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToArgs = (input: any) => string[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function register(name: any, description: string, inputSchema: any, toArgs: ToArgs) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, { description, inputSchema },
    async (input: any) => {
      if (!isMacOS()) return { content: [{ type: 'text', text: macOnlyError() }], isError: true };

      const invoker = resolveAgentDesktopInvoker();
      if (!invoker.available) {
        return {
          content: [{ type: 'text', text: 'agent-desktop is not installed. Run /mcp and install Desktop Automation to set it up.' }],
          isError: true,
        };
      }

      let args: string[];
      try {
        args = toArgs(input ?? {});
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Invalid arguments: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const result = await runDesktop(args);
      if (!result.success) {
        return { content: [{ type: 'text', text: formatError(result) }], isError: true };
      }
      const output = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      return { content: [{ type: 'text', text: output }] };
    },
  );
}

// ── Register all tools ─────────────────────────────────────────────────

register('computer_snapshot',
  'Capture an accessibility-tree snapshot of the macOS desktop. Returns stable element refs (e.g. @e1, @e2) that can be used with computer_click, computer_type, computer_scroll, and computer_get.',
  ComputerSnapshotInputSchema,
  (input) => buildCliArgs('snapshot', input, {
    flags: {
      app: 'app',
      window_id: 'window-id',
      interactive_only: 'interactive-only',
      include_bounds: 'include-bounds',
      compact: 'compact',
      max_depth: 'max-depth',
      surface: 'surface',
    },
  }),
);

register('computer_screenshot',
  'Take a PNG screenshot of the macOS desktop, a specific window, or a specific application.',
  ComputerScreenshotInputSchema,
  (input) => buildCliArgs('screenshot', input, {
    positional: ['output_path'],
    flags: { app: 'app', window_id: 'window-id' },
  }),
);

register('computer_click',
  'Click a desktop UI element by ref (from computer_snapshot) or by screen coordinates. Supports left/right/middle button and single/double/triple click.',
  ComputerClickInputSchema,
  (input) => {
    if (input.ref) return ['click', input.ref];
    if (input.x !== undefined && input.y !== undefined) {
      const args = ['mouse-click', '--xy', `${input.x},${input.y}`];
      if (input.button) args.push('--button', input.button);
      if (input.count) args.push('--count', input.count);
      return args;
    }
    throw new Error('Either ref or x,y coordinates are required');
  },
);

register('computer_mouse_move',
  'Move the mouse to a desktop element (by ref) or to absolute screen coordinates.',
  ComputerMouseMoveInputSchema,
  (input) => {
    if (input.ref) return ['hover', input.ref];
    if (input.x !== undefined && input.y !== undefined) {
      return ['mouse-move', '--xy', `${input.x},${input.y}`];
    }
    throw new Error('Either ref or x,y coordinates are required');
  },
);

register('computer_type',
  'Type text into a focused desktop UI element identified by ref from computer_snapshot.',
  ComputerTypeInputSchema,
  (input) => buildCliArgs('type', input, {
    positional: ['ref', 'text'],
  }),
);

register('computer_press',
  'Press a key or key chord (e.g. cmd+s, Enter, Escape) on the macOS desktop. Use for keyboard shortcuts.',
  ComputerPressInputSchema,
  (input) => buildCliArgs('press', input, {
    positional: ['key'],
    flags: { app: 'app' },
  }),
);

register('computer_scroll',
  'Scroll a desktop UI element (by ref from computer_snapshot) in the specified direction.',
  ComputerScrollInputSchema,
  (input) => buildCliArgs('scroll', input, {
    positional: ['ref'],
    flags: { direction: 'direction', amount: 'amount' },
  }),
);

register('computer_launch',
  'Launch a macOS application by name and optionally wait for its window to appear.',
  ComputerLaunchInputSchema,
  (input) => buildCliArgs('launch', input, {
    positional: ['app'],
    flags: { timeout_ms: 'timeout' },
  }),
);

register('computer_list_windows',
  'List open windows on the macOS desktop, optionally filtered by application. Returns window IDs for computer_focus_window.',
  ComputerListWindowsInputSchema,
  (input) => buildCliArgs('list-windows', input, {
    flags: { app: 'app' },
  }),
);

register('computer_focus_window',
  'Focus a macOS window by ID, app name, or title. Use after computer_list_windows.',
  ComputerFocusWindowInputSchema,
  (input) => buildCliArgs('focus-window', input, {
    flags: { window_id: 'window-id', app: 'app', title: 'title' },
  }),
);

register('computer_get',
  'Read properties (text, value, title, bounds, role, states) from a desktop element ref.',
  ComputerGetInputSchema,
  (input) => buildCliArgs('get', input, {
    positional: ['ref'],
    flags: { property: 'property' },
  }),
);

register('computer_wait',
  'Wait for a condition on the macOS desktop: delay, element appearance, window, text, or menu open/close.',
  ComputerWaitInputSchema,
  (input) => buildCliArgs('wait', input, {
    positional: ['milliseconds'],
    flags: {
      element: 'element',
      window: 'window',
      text: 'text',
      timeout_ms: 'timeout',
      menu_open: 'menu',
      menu_closed: 'menu-closed',
    },
  }),
);

// ── Skill tool ────────────────────────────────────────────────────────

const ComputerSkillInputSchema = z.object({
  full: z.boolean().optional().describe('Include all reference files (commands, workflows, macos internals)'),
});

register('computer_skill',
  'CRITICAL: Call this FIRST before any desktop automation. Returns the complete agent-desktop workflow guide: the observe-act loop (skeleton→drill→act→verify), ref system (@e1, @e2), command quick reference, error codes with recovery hints, and key principles. Use this to understand how to navigate and control the desktop effectively.',
  ComputerSkillInputSchema,
  (input) => {
    const args = ['skills', 'get', 'desktop'];
    if (input.full) args.push('--full');
    return args;
  },
);

// ── Start ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('agent-desktop MCP server failed to start:', err);
  process.exit(1);
});
