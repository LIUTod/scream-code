import { literalRulePattern, matchesGlobRuleSubject } from './rule-match';

/**
 * Command-template permission rules for the Bash tool.
 *
 * The permission DSL records an approved action as an `approvalRule`
 * pattern. Bash by default records the exact command text
 * (literalRulePattern), so approving `git checkout main` does not cover
 * `git checkout feature/x` — every branch or flag variant asks again.
 *
 * The curated family table below fixes that for safe, high-frequency
 * command families: an approved `git checkout main` is remembered as
 * `git checkout *`, and the segment matcher lets that template cover any
 * argument — including path segments like `feature/x`, which a plain glob
 * `*` would not match because `*` does not cross `/`.
 *
 * Safety invariants (why this cannot widen the attack surface):
 *   - Only families listed in COMMAND_FAMILIES are ever normalized or
 *     segment-matched. User-written rules like `Bash(rm *)` keep their
 *     existing glob semantics: `rm *` still does not match `rm -rf /`.
 *   - Templates are constant strings from the table; no user input enters
 *     a template, so nothing from the command needs escaping.
 *   - The segment matcher compares literal prefix tokens only. Commands
 *     with quoted or otherwise non-plain segments fail the family check
 *     and fall back to glob matching — a miss asks again, never an
 *     unintended allow.
 */

const FAMILY_ENTRIES = [
  'git checkout',
  'git switch',
  'git pull',
  'git push',
  'git fetch',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git add',
  'npm install',
  'npm i',
  'npm ci',
  'pnpm install',
  'pnpm i',
  'pnpm add',
  'yarn install',
  'yarn add',
  'bun install',
  'bun i',
  'bun add',
  'cargo build',
  'cargo test',
  'cargo check',
  'cargo fmt',
  'cargo add',
  'cargo update',
  'go test',
  'go build',
  'go vet',
  'uv add',
  'uv sync',
  'uv pip',
  'pip install',
  'pip3 install',
  'pytest',
  'vitest',
  'jest',
] as const;

/** Families eligible for command-template normalization and segment matching. */
export const COMMAND_FAMILIES: ReadonlySet<string> = new Set(FAMILY_ENTRIES);

/**
 * Force-style flags that never normalize into a family template. An approved
 * `git checkout -f .` stays a literal rule and does not open the whole
 * checkout family, so `git checkout -f <anything-else>` keeps asking.
 */
const FAMILY_HAZARD_TOKENS = new Set(['-f', '--force', '--force-with-lease', '--hard']);

/**
 * Plain literal segment: letters/digits plus `.` `_` `@` `-`.
 * Rejects glob metacharacters, `/`, quotes, and anything with whitespace.
 */
const LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Build the approval rule for an executed Bash command.
 *
 * When the command's first two tokens name a family in COMMAND_FAMILIES, the
 * rule is the family template (`Bash(git checkout *)`); otherwise the exact
 * command literal is preserved (the previous behaviour).
 */
export function commandApprovalRule(toolName: string, command: string): string {
  const family = commandFamily(command);
  if (family !== undefined) return `${toolName}(${family} *)`;
  return literalRulePattern(toolName, command);
}

/**
 * Match a rule pattern against an executed Bash command.
 *
 * Command templates (`git checkout *` / `pytest *`) whose family is in
 * COMMAND_FAMILIES are matched segment-wise: every literal prefix token must
 * equal the corresponding command token, and the command may carry any number
 * of trailing segments. All other patterns keep the plain glob behaviour.
 */
export function matchesCommandRule(ruleArgs: string, command: string): boolean {
  const negated = ruleArgs.startsWith('!');
  const positive = negated ? ruleArgs.slice(1) : ruleArgs;
  const template = parseTemplate(positive);
  if (template !== undefined && COMMAND_FAMILIES.has(template.family)) {
    const segments = splitSegments(command);
    const hit =
      segments.length >= template.prefix.length &&
      template.prefix.every((segment, index) => segment === segments[index]);
    return negated ? !hit : hit;
  }
  return matchesGlobRuleSubject(ruleArgs, command);
}

function commandFamily(command: string): string | undefined {
  const segments = splitSegments(command);
  if (segments.length < 2) return undefined;
  const family = `${segments[0]} ${segments[1]}`;
  if (!COMMAND_FAMILIES.has(family)) return undefined;
  // Force-style trailing flags make the approved command a deliberate,
  // potentially destructive invocation. Do not generalize it to the whole
  // family: the created rule stays a literal approval.
  if (segments.slice(2).some((segment) => FAMILY_HAZARD_TOKENS.has(segment))) return undefined;
  return family;
}

function parseTemplate(
  ruleArgs: string,
): { readonly family: string; readonly prefix: readonly string[] } | undefined {
  const segments = splitSegments(ruleArgs);
  if (segments.length === 0 || segments.at(-1) !== '*') return undefined;
  const prefix = segments.slice(0, -1);
  if (prefix.length === 0) return undefined;
  if (!prefix.every((segment) => LITERAL_SEGMENT.test(segment))) return undefined;
  return { family: prefix.join(' '), prefix };
}

function splitSegments(value: string): string[] {
  return value.trim().split(/\s+/).filter((segment) => segment.length > 0);
}
