/**
 * Runtime options for the built-in Chrome DevTools MCP server.
 *
 * Why this lives in its own module: the `/mcp` submenu is a view over launch
 * args, not a second settings store. `~/.scream-code/mcp.json` stays the single
 * source of truth, so a flag typed by hand behaves exactly like one chosen in
 * the menu, and the drift/reset path keeps seeing the same args the server is
 * launched with.
 *
 * Only the flags listed here are parsed back out. Everything else in the entry
 * (custom flags, env, timeouts) is left to the caller — a user who added
 * `--blocked-url-pattern` keeps it.
 *
 * The base flags are the ones the product owns (privacy, screenshot size, the
 * two opt-in tool categories); the option flags are the ones a user is allowed
 * to trade away.
 */

export type ChromeChannel = 'stable' | 'beta' | 'dev' | 'canary';

export interface BrowserRuntimeOptions {
  /** `--headless`: no visible window. Faster start, nothing to look at. */
  headless: boolean;
  /** `--isolated`: a throwaway user-data-dir — no cookies, no logins, no state. */
  isolated: boolean;
  /** `--viewport=WxH`: fixed layout, so design review does not depend on the screen. */
  viewport?: string;
  /**
   * `--auto-connect`: drive a Chrome the user already started (Chrome 144+,
   * remote debugging enabled from `chrome://inspect`). The server then does not
   * launch the browser, so `headless`/`isolated` have nothing to act on.
   */
  autoConnect: boolean;
  /** `--channel=`: which installed Chrome to launch. */
  channel: ChromeChannel;
}

export const CHROME_DEVTOOLS_PACKAGE = 'chrome-devtools-mcp@latest';

export const CHROME_CHANNELS: readonly ChromeChannel[] = ['stable', 'beta', 'dev', 'canary'];

/**
 * Viewport presets rather than free text: the point is a *deterministic* layout
 * for visual verification, and three common widths cover desktop review. The
 * first entry (`undefined`) means "whatever the browser decides".
 */
export const VIEWPORT_PRESETS: readonly (string | undefined)[] = [
  undefined,
  '1280x800',
  '1440x900',
  '1920x1200',
];

export const DEFAULT_BROWSER_OPTIONS: BrowserRuntimeOptions = {
  headless: false,
  isolated: false,
  autoConnect: false,
  channel: 'stable',
};

/**
 * Product-owned flags. Order matters only for readability; the rationale is
 * per-flag because these are decisions, not defaults:
 *
 * - `--no-usage-statistics` / `--no-performance-crux`: no telemetry, and trace
 *   URLs never leave the machine.
 * - `--redact-network-headers`: headers are redacted before the model sees them.
 * - `--no-file-navigations`: `file:` navigation plus `take_snapshot` would read
 *   arbitrary local files, bypassing the workspace boundary we enforce elsewhere.
 * - `--screenshot-*`: a full-size PNG dominates the context; JPEG + width cap.
 * - `--category-network-mocks` / `--memory-debugging`: opt-in categories that
 *   complete a capability instead of leaving half of it unreachable (mocks are
 *   the only way to test error states; a heap snapshot without the analysis
 *   tools is an unreadable blob).
 */
export const CHROME_DEVTOOLS_BASE_FLAGS: readonly string[] = [
  '--no-usage-statistics',
  '--no-performance-crux',
  '--redact-network-headers',
  '--no-file-navigations',
  '--screenshot-format=jpeg',
  '--screenshot-quality=85',
  '--screenshot-max-width=1600',
  '--category-network-mocks',
  '--memory-debugging',
];

/**
 * Flags the submenu owns, for one options value. Defaults emit nothing so the
 * installed entry stays as small as the recommendation describes.
 */
export function browserOptionFlags(options: BrowserRuntimeOptions): string[] {
  const flags: string[] = [];
  if (options.headless) flags.push('--headless');
  if (options.isolated) flags.push('--isolated');
  if (options.autoConnect) flags.push('--auto-connect');
  if (options.viewport !== undefined && options.viewport.length > 0) {
    flags.push(`--viewport=${options.viewport}`);
  }
  if (options.channel !== 'stable') flags.push(`--channel=${options.channel}`);
  return flags;
}

/**
 * Flags this module models. Everything else in an entry belongs to the user.
 * Kept next to `browserOptionFlags` so a new option cannot be forgotten here.
 */
const BOOLEAN_FLAG_NAMES: readonly string[] = ['--headless', '--isolated', '--auto-connect', '--autoConnect'];

/** Flags that take a separate value (`--viewport 1280x800`); the boolean ones above do not. */
const VALUE_FLAG_NAMES: readonly string[] = ['--viewport', '--channel'];

const OPTION_FLAG_NAMES: readonly string[] = [...BOOLEAN_FLAG_NAMES, ...VALUE_FLAG_NAMES];

/**
 * Full launch args: npx invocation + product flags + the chosen options.
 *
 * `packageSpec` and `keep` exist so a caller can re-emit an entry without
 * destroying what the user added: the menu models five options, and silently
 * dropping `--browserUrl`/`--proxyServer` just because someone toggled headless
 * would be a data-loss bug wearing a settings UI.
 */
export function buildBrowserArgs(
  options: BrowserRuntimeOptions,
  extra: { packageSpec?: string; keep?: readonly string[] } = {},
): string[] {
  return [
    '-y',
    extra.packageSpec ?? CHROME_DEVTOOLS_PACKAGE,
    ...CHROME_DEVTOOLS_BASE_FLAGS,
    ...browserOptionFlags(options),
    ...(extra.keep ?? []),
  ];
}

/** The package spec the entry was installed with (a pin stays a pin). */
export function installedPackageSpec(args: readonly string[]): string {
  return args.find((token) => token.startsWith('chrome-devtools-mcp')) ?? CHROME_DEVTOOLS_PACKAGE;
}

/**
 * Tokens this module does not manage, to be re-appended verbatim.
 *
 * Strips: npx's `-y`, the package spec, the product base flags, and the option
 * flags together with their separate values (`--viewport 1280x800`). Anything
 * else — `--browserUrl`, `--wsEndpoint`, `--proxyServer=…`, `--chromeArg=…` —
 * is the user's and survives a save.
 */
export function unmanagedArgs(args: readonly string[]): string[] {
  const managedPrefixes = [...CHROME_DEVTOOLS_BASE_FLAGS, ...OPTION_FLAG_NAMES];
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (token === '-y' || token.startsWith('chrome-devtools-mcp')) continue;
    // `--no-headless` is the same option as `--headless=false`: parsed above and
    // re-emitted from the options, so it must not also survive as a stray flag
    // that contradicts what the menu writes.
    const managed =
      managedPrefixes.some((prefix) => token === prefix || token.startsWith(`${prefix}=`)) ||
      BOOLEAN_FLAG_NAMES.some((name) => token === negatedFlag(name));
    if (managed) {
      if (!token.includes('=')) {
        const next = args[index + 1];
        if (VALUE_FLAG_NAMES.includes(token)) {
          // `--viewport 1280x800` / `--channel stable`: its value is ours too.
          if (next !== undefined && !next.startsWith('-')) index += 1;
        } else if (BOOLEAN_FLAG_NAMES.includes(token) && isBooleanWord(next)) {
          // `--headless false`: yargs reads a following true/false as the value.
          index += 1;
        }
      }
      continue;
    }
    kept.push(token);
  }
  return kept;
}

/**
 * Read the option flags back out of an installed args array.
 *
 * Tolerant by design: this runs against entries the user may have edited, so
 * unknown spellings and stray values fall back to the default instead of
 * throwing. Both `--kebab-case` and `--camelCase` are accepted (yargs accepts
 * both, and hand-edits follow whichever the docs showed first), as is
 * `--flag value` next to `--flag=value`.
 */
export function parseBrowserOptions(args: readonly string[]): BrowserRuntimeOptions {
  const options: BrowserRuntimeOptions = { ...DEFAULT_BROWSER_OPTIONS };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const headless = readBooleanFlag(token, args, index, ['--headless']);
    if (headless !== undefined) {
      if (headless.value !== undefined) options.headless = headless.value;
      if (headless.consumedNext) index += 1;
      continue;
    }
    const isolated = readBooleanFlag(token, args, index, ['--isolated']);
    if (isolated !== undefined) {
      if (isolated.value !== undefined) options.isolated = isolated.value;
      if (isolated.consumedNext) index += 1;
      continue;
    }
    const autoConnect = readBooleanFlag(token, args, index, ['--auto-connect', '--autoConnect']);
    if (autoConnect !== undefined) {
      if (autoConnect.value !== undefined) options.autoConnect = autoConnect.value;
      if (autoConnect.consumedNext) index += 1;
      continue;
    }
    const viewport = readFlagValue(token, args, index, '--viewport');
    if (viewport !== undefined) {
      options.viewport = viewport.value.length > 0 ? viewport.value : undefined;
      if (viewport.consumedNext) index += 1;
      continue;
    }
    const channel = readFlagValue(token, args, index, '--channel');
    if (channel !== undefined) {
      options.channel = asChannel(channel.value);
      if (channel.consumedNext) index += 1;
    }
  }
  return options;
}

/** `--headless` → `--no-headless` (also for `--autoConnect` → `--no-autoConnect`). */
function negatedFlag(name: string): string {
  return `--no-${name.slice(2)}`;
}

function isBooleanWord(raw: string | undefined): boolean {
  const word = raw?.trim().toLowerCase();
  return word === 'true' || word === 'false';
}

/**
 * A boolean option in every spelling yargs accepts: `--flag`, `--flag=true|false`,
 * `--flag true|false` and `--no-flag`. Undefined when `token` is not one of
 * `names`. `value` is undefined for a recognised flag with a value that is not a
 * boolean (`--headless=maybe`): tolerated like any hand edit — the default
 * stands — but still ours, so it is not carried along as a stray flag.
 */
function readBooleanFlag(
  token: string | undefined,
  args: readonly string[],
  index: number,
  names: readonly string[],
): { value: boolean | undefined; consumedNext: boolean } | undefined {
  if (token === undefined) return undefined;
  for (const name of names) {
    if (token === negatedFlag(name)) return { value: false, consumedNext: false };
    if (token === name) {
      const next = args[index + 1];
      if (isBooleanWord(next)) {
        return { value: next?.trim().toLowerCase() === 'true', consumedNext: true };
      }
      return { value: true, consumedNext: false };
    }
    if (token.startsWith(`${name}=`)) {
      const raw = token.slice(name.length + 1).trim().toLowerCase();
      return { value: raw === 'true' ? true : raw === 'false' ? false : undefined, consumedNext: false };
    }
  }
  return undefined;
}

function readFlagValue(
  token: string | undefined,
  args: readonly string[],
  index: number,
  flag: string,
): { value: string; consumedNext: boolean } | undefined {
  if (token === undefined) return undefined;
  if (token === flag) {
    const next = args[index + 1];
    // A following flag means the value was omitted; leave it to the default
    // rather than swallowing the next option.
    if (next === undefined || next.startsWith('--')) return undefined;
    return { value: next, consumedNext: true };
  }
  if (token.startsWith(`${flag}=`)) {
    return { value: token.slice(flag.length + 1), consumedNext: false };
  }
  return undefined;
}

function asChannel(raw: string): ChromeChannel {
  const normalized = raw.trim().toLowerCase();
  return (CHROME_CHANNELS as readonly string[]).includes(normalized)
    ? (normalized as ChromeChannel)
    : 'stable';
}

/** Next viewport preset, wrapping. Kept here so the menu has no index math. */
export function cycleViewport(current: string | undefined): string | undefined {
  const index = VIEWPORT_PRESETS.findIndex((preset) => preset === current);
  // An unknown value (hand-edited) restarts from the first preset.
  const next = index < 0 ? 0 : (index + 1) % VIEWPORT_PRESETS.length;
  return VIEWPORT_PRESETS[next];
}

export function cycleChannel(current: ChromeChannel): ChromeChannel {
  const index = CHROME_CHANNELS.indexOf(current);
  return CHROME_CHANNELS[(index + 1) % CHROME_CHANNELS.length] ?? 'stable';
}

/**
 * Why a launch-time option cannot take effect right now.
 *
 * Auto-connect does not launch Chrome, so `headless` and `isolated` (both
 * launch-time profile decisions) are inert. Returning the reason lets the menu
 * refuse instead of saving a combination that silently does nothing.
 */
export function launchOptionBlocker(
  options: BrowserRuntimeOptions,
): 'auto-connect' | undefined {
  return options.autoConnect ? 'auto-connect' : undefined;
}
