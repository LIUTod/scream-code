/**
 * Dangerous-command warnings.
 *
 * Detection is advisory, not a block: a matched pattern forces a fresh
 * approval prompt (see `WarningsAskPermissionPolicy`) and supplies the
 * human-readable reasons the approval panel renders. Patterns are deliberately
 * narrow — a false positive costs one extra prompt, while a false negative
 * would let a destructive command through unnoticed.
 */

interface DangerousCommandPattern {
  readonly pattern: RegExp;
  readonly warning: string;
}

/**
 * Declaration order is the display order, so the riskiest families come first.
 * Every warning is a standalone English sentence; consumers render them as-is.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly DangerousCommandPattern[] = [
  {
    pattern:
      /\brm\s+(?=[^|;&\n]*(?<![\w])(?:-[a-zA-Z]*r[a-zA-Z]*\b|--recursive\b))(?=[^|;&\n]*(?<![\w])(?:-[a-zA-Z]*f[a-zA-Z]*\b|--force\b))/i,
    warning: 'dangerous command: recursive force delete',
  },
  {
    pattern: /\bsudo\b/,
    warning: 'dangerous command: privilege escalation',
  },
  {
    pattern: /\bmkfs\b/,
    warning: 'dangerous command: filesystem format',
  },
  {
    pattern: /\bdd\s+if=/,
    warning: 'dangerous command: raw disk write',
  },
  {
    pattern: /curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh/,
    warning: 'dangerous command: download piped into a shell',
  },
  {
    pattern: /\bchmod\s+-R\s+777\b/,
    warning: 'dangerous command: world-writable recursive chmod',
  },
  {
    pattern: />\s*\/dev\/sd/,
    warning: 'dangerous command: write to a raw disk device',
  },
  {
    pattern: /\bshutdown\b/,
    warning: 'dangerous command: system shutdown',
  },
  {
    pattern: /\breboot\b/,
    warning: 'dangerous command: system reboot',
  },
  {
    pattern: /\bgit\s+(?:-C\s+\S+\s+)?push\b.*(?:\s-f\b|--force\b)/,
    warning: 'dangerous command: force push',
  },
];

/**
 * Warnings triggered by `command`, in declaration order. Returns an empty
 * array for ordinary commands, and for input that is not a command string.
 */
export function dangerousCommandWarnings(command: string): readonly string[] {
  if (command.length === 0) return [];
  const warnings: string[] = [];
  for (const { pattern, warning } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) warnings.push(warning);
  }
  return warnings;
}
