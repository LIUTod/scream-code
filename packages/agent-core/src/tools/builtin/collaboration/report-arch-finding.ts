/**
 * ReportArchFindingTool — diagnosis finding collector.
 *
 * Oracle subagents use this tool to record each issue they find while
 * diagnosing code that already exists (architecture, debt, maintainability,
 * dead weight). Findings are stored in the agent-level tool store so the
 * parent agent can aggregate them after the diagnosis completes.
 *
 * Deliberately separate from `ReportFinding`: review findings are anchored to
 * a patch (required file/line, range ≤10, must overlap the diff), while
 * findings about an existing codebase are frequently module- or repo-level
 * and cannot honour those constraints without forcing the model to invent
 * line numbers.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ToolStore } from '../../store';
import DESCRIPTION from './report-arch-finding.md';

// ── Finding state shape ────────────────────────────────────────────────

export type ArchTag =
  | 'dead'
  | 'dup'
  | 'wrong-layer'
  | 'over-build'
  | 'under-build'
  | 'debt'
  | 'portable';

export type ArchSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export interface ArchFinding {
  readonly title: string;
  readonly problem: string;
  readonly fix: string;
  readonly tag: ArchTag;
  readonly severity: ArchSeverity;
  readonly confidence: number;
  readonly file_path?: string | undefined;
  readonly line_start?: number | undefined;
  readonly line_end?: number | undefined;
}

const ARCH_FINDINGS_STORE_KEY = 'archFindings';

// ── Schema ─────────────────────────────────────────────────────────────

export const ReportArchFindingInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe('Imperative title, ≤80 chars. Example: "Delete the wrapper that only forwards".'),
  problem: z
    .string()
    .min(1)
    .describe('What is wrong, when it bites, what it costs. One paragraph. Neutral tone.'),
  fix: z
    .string()
    .min(1)
    .describe('The concrete replacement. One or two imperative sentences. Required: a finding without a replacement is a complaint, not a finding.'),
  tag: z
    .enum(['dead', 'dup', 'wrong-layer', 'over-build', 'under-build', 'debt', 'portable'])
    .describe('What replaces it: dead=delete · dup=keep one · wrong-layer=move or invert · over-build=inline until a second consumer · under-build=extract once · debt=name the ceiling and the trigger · portable=use the built-in.'),
  severity: z
    .enum(['P0', 'P1', 'P2', 'P3'])
    .describe('P0 blocks the next change, P1 high friction, P2 medium friction, P3 cleanup.'),
  confidence: z.number().min(0).max(1).describe('Confidence the issue is real (0.0-1.0).'),
  file_path: z
    .string()
    .optional()
    .describe('Path to the affected file. Omit for module- or repo-level issues.'),
  line_start: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('First line (1-indexed). Omit for module- or repo-level issues.'),
  line_end: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Last line (1-indexed). Omit for module- or repo-level issues.'),
});

export type ReportArchFindingInput = z.infer<typeof ReportArchFindingInputSchema>;

/**
 * Collapse a field that must stay on one line. Without this a newline inside a
 * title or a path would let the field's own text land at bullet level and read
 * as an extra finding.
 */
function oneLine(text: string): string {
  return text.split('\n').join(' ');
}

function location(finding: ArchFinding): string {
  if (finding.file_path === undefined) return 'repo';
  const path = oneLine(finding.file_path);
  if (finding.line_start === undefined) return path;
  if (finding.line_end === undefined || finding.line_end === finding.line_start) {
    return `${path}:${finding.line_start}`;
  }
  return `${path}:${finding.line_start}-${finding.line_end}`;
}

// ── Formatting ─────────────────────────────────────────────────────────

function renderFinding(finding: ArchFinding): string {
  return `[${finding.severity}][${finding.tag}] ${oneLine(finding.title)}\n${location(finding)}\nConfidence: ${(finding.confidence * 100).toFixed(0)}%\n${finding.problem}\n${finding.fix}`;
}

/**
 * Body continuation lines are indented to the same column as the first. The
 * schema asks for one paragraph but does not enforce it, and an unindented
 * newline would let a field's own text land at bullet level and read as an
 * extra finding.
 */
function indentContinuation(text: string): string {
  return text.split('\n').join('\n  ');
}

/**
 * Render findings as the `[arch_findings]` block appended to the child's
 * result. `problem` and `fix` are both carried on their own lines: a title
 * and a tag alone do not tell the parent why the finding matters or what to
 * do about it. Title and location are collapsed to one line; `problem` and
 * `fix` keep their line breaks with continuation indented, so neither can
 * forge a bullet at column 0.
 */
export function formatArchFindingsBlock(findings: readonly ArchFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map(
    (f) =>
      `- [${f.severity}][${f.tag}] ${oneLine(f.title)} (${location(f)}) confidence=${(f.confidence * 100).toFixed(0)}%\n  problem: ${indentContinuation(f.problem)}\n  fix: ${indentContinuation(f.fix)}`,
  );
  return `\n\n[arch_findings]\n${lines.join('\n')}`;
}

// ── Tool ───────────────────────────────────────────────────────────────

export class ReportArchFindingTool implements BuiltinTool<ReportArchFindingInput> {
  readonly name = 'ReportArchFinding' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReportArchFindingInputSchema);

  constructor(private readonly store: ToolStore) {}

  resolveExecution(args: ReportArchFindingInput): ToolExecution {
    // The description lands on a TUI activity row, so the title stays one line.
    const description = `Recording ${args.severity} ${args.tag} finding: ${oneLine(args.title)}`;
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        const rangeError = validateRange(args);
        if (rangeError !== undefined) {
          return { isError: true, output: `Invalid ReportArchFinding input: ${rangeError}.` };
        }

        const finding: ArchFinding = {
          title: args.title,
          problem: args.problem,
          fix: args.fix,
          tag: args.tag,
          severity: args.severity,
          confidence: args.confidence,
          file_path: args.file_path,
          line_start: args.line_start,
          line_end: args.line_end,
        };
        const next = [...getArchFindingsFromStore(this.store), finding];
        this.store.set(ARCH_FINDINGS_STORE_KEY, next);

        return {
          isError: false,
          output: `Finding recorded.\n\n${renderFinding(finding)}\n\nTotal findings: ${next.length}`,
        };
      },
    };
  }
}

function validateRange(args: ReportArchFindingInput): string | undefined {
  const { file_path: filePath, line_start: lineStart, line_end: lineEnd } = args;
  if (lineStart === undefined && lineEnd !== undefined) {
    return 'line_start is required when line_end is given';
  }
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    return `line_end (${lineEnd}) must be >= line_start (${lineStart})`;
  }
  // A line number without a file cannot anchor anything. Either both anchors
  // are absent (module/repo-level) or the file is named.
  if (filePath === undefined && (lineStart !== undefined || lineEnd !== undefined)) {
    return 'file_path is required when line_start or line_end is given';
  }
  return undefined;
}

/** Helper used by the parent agent to read accumulated findings from the store. */
export function getArchFindingsFromStore(store: ToolStore): readonly ArchFinding[] {
  return store.get(ARCH_FINDINGS_STORE_KEY) ?? [];
}
