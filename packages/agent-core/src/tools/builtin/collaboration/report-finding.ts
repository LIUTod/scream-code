/**
 * ReportFindingTool — structured code-review finding collector.
 *
 * Reviewer subagents use this tool to record each issue they find. Findings
 * are stored in the agent-level tool store so the parent agent can aggregate
 * them after the review completes.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ToolStore } from '../../store';
import DESCRIPTION from './report-finding.md';

// ── Finding state shape ────────────────────────────────────────────────

export type FindingPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface ReviewFinding {
  readonly title: string;
  readonly body: string;
  readonly priority: FindingPriority;
  readonly confidence: number;
  readonly file_path: string;
  readonly line_start: number;
  readonly line_end: number;
}

const FINDINGS_STORE_KEY = 'findings';

// ── Schema ─────────────────────────────────────────────────────────────

export const ReportFindingInputSchema = z.object({
  title: z.string().min(1).describe('Imperative title, ≤80 chars. Example: "Validate input length before buffer copy".'),
  body: z
    .string()
    .min(1)
    .describe('One paragraph: bug, trigger condition, impact. Neutral tone.'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).describe('P0 blocks release, P1 fix next cycle, P2 fix eventually, P3 nice to have.'),
  confidence: z.number().min(0).max(1).describe('Confidence the issue is a real bug (0.0-1.0).'),
  file_path: z.string().min(1).describe('Path to the affected file.'),
  line_start: z.number().int().min(1).describe('First line (1-indexed).'),
  line_end: z.number().int().min(1).describe('Last line (1-indexed, ≤10 lines from line_start).'),
});

export type ReportFindingInput = z.infer<typeof ReportFindingInputSchema>;

function renderFinding(finding: ReviewFinding): string {
  const location =
    finding.line_start === finding.line_end
      ? `${finding.file_path.split('\n').join(' ')}:${finding.line_start}`
      : `${finding.file_path.split('\n').join(' ')}:${finding.line_start}-${finding.line_end}`;
  return `[${finding.priority}] ${finding.title.split('\n').join(' ')}\n${location}\nConfidence: ${(finding.confidence * 100).toFixed(0)}%\n${finding.body}`;
}

export class ReportFindingTool implements BuiltinTool<ReportFindingInput> {
  readonly name = 'ReportFinding' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReportFindingInputSchema);

  constructor(private readonly store: ToolStore) {}

  resolveExecution(args: ReportFindingInput): ToolExecution {
    // The description lands on a TUI activity row, so the title stays one line.
    const description = `Recording ${args.priority} finding: ${args.title.split('\n').join(' ')}`;
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        if (args.line_end < args.line_start) {
          return {
            isError: true,
            output: `Invalid ReportFinding input: line_end (${args.line_end}) must be >= line_start (${args.line_start}).`,
          };
        }

        const current = this.getFindings();
        const finding: ReviewFinding = {
          title: args.title,
          body: args.body,
          priority: args.priority,
          confidence: args.confidence,
          file_path: args.file_path,
          line_start: args.line_start,
          line_end: args.line_end,
        };
        const next = [...current, finding];
        this.store.set(FINDINGS_STORE_KEY, next);

        return {
          isError: false,
          output: `Finding recorded.\n\n${renderFinding(finding)}\n\nTotal findings: ${next.length}`,
        };
      },
    };
  }

  private getFindings(): readonly ReviewFinding[] {
    const findings = this.store.get(FINDINGS_STORE_KEY);
    return findings ?? [];
  }
}

/** Helper used by the parent agent to read accumulated findings from the store. */
export function getFindingsFromStore(store: ToolStore): readonly ReviewFinding[] {
  const findings = store.get(FINDINGS_STORE_KEY);
  return findings ?? [];
}

/**
 * Render findings as the `[review_findings]` block appended to the child's
 * result. Body is included on its own line: a title and a line number alone
 * do not tell the parent why the finding is a bug.
 *
 * Title and path are collapsed to one line; body continuation lines are
 * indented to the same column as the first. The schema asks for one paragraph
 * but does not enforce it, and an unindented newline would let a field's own
 * text land at bullet level and read as an extra finding.
 */
export function formatFindingsBlock(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map(
    (f) =>
      `- [${f.priority}] ${f.title.split('\n').join(' ')} (${f.file_path.split('\n').join(' ')}:${f.line_start}${
        f.line_end === f.line_start ? '' : `-${f.line_end}`
      }) confidence=${(f.confidence * 100).toFixed(0)}%\n  ${f.body.split('\n').join('\n  ')}`,
  );
  return `\n\n[review_findings]\n${lines.join('\n')}`;
}
