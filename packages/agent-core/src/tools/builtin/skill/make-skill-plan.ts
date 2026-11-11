import { z } from 'zod';

import type { Agent } from '#/agent';
import type { ContextMessage } from '#/agent/context/types';
import { ErrorCodes, ScreamError } from '#/errors';
import { parseSkillText } from '#/skill/parser';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import {
  sanitizeSkillName,
  SKILL_TYPE_SCHEMA,
} from './skill-package-writer';
import CODE_PATTERN_TEMPLATE from './templates/code-pattern.md';
import CUSTOM_TEMPLATE from './templates/custom.md';
import TOOL_CHAIN_TEMPLATE from './templates/tool-chain.md';
import TROUBLESHOOTING_TEMPLATE from './templates/troubleshooting.md';
import WORKFLOW_TEMPLATE from './templates/workflow.md';

const MakeSkillPlanInputSchema = z.object({
  type: SKILL_TYPE_SCHEMA.describe(
    'The kind of skill to craft: workflow, code-pattern, troubleshooting, tool-chain, or custom.',
  ),
  nameHint: z.string().default('').describe('Optional kebab-case name suggested by the user.'),
  purpose: z.string().default('').describe('One-sentence description of what problem this skill solves.'),
  focus: z.string().default('').describe('User-provided focus: which parts of the conversation to extract or emphasize.'),
});

export type MakeSkillPlanInput = z.infer<typeof MakeSkillPlanInputSchema>;

interface SkillPlan {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly content: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly verification: PlanVerification;
}

/**
 * Trigger checks that ship with the plan but not with the skill body.
 *
 * A generated skill is only worth keeping if it fires on the requests it was
 * written for and stays quiet on near misses. The plan carries that test so the
 * person who asked for the skill can run it in one sentence, and so a review of
 * the skill has something falsifiable to check.
 */
interface PlanVerification {
  readonly triggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly acceptance: string;
  /** Filled by the tool from the three fields above; never authored by the model. */
  readonly instructions: string;
}

const TEMPLATES: Record<MakeSkillPlanInput['type'], string> = {
  workflow: WORKFLOW_TEMPLATE,
  'code-pattern': CODE_PATTERN_TEMPLATE,
  troubleshooting: TROUBLESHOOTING_TEMPLATE,
  'tool-chain': TOOL_CHAIN_TEMPLATE,
  custom: CUSTOM_TEMPLATE,
};

const SYSTEM_PROMPT = `You are a skill author for Scream Code.

Analyze the conversation transcript and the user's explicit guidance, then produce a reusable Scream Code Skill package as JSON.

The package must contain:
- name: kebab-case skill name. Prefer the user's nameHint if it is valid kebab-case; otherwise derive a concise name from the purpose.
- description: one sentence describing when to use this skill.
- when-to-use: **required** — 1-2 sentences describing the specific situations/trigger conditions that should make the agent use this skill. Must include: (a) concrete trigger phrases/keywords the user might say (e.g. "convert", "PDF", "debug", "snapshot"), (b) the specific scenario or task type (e.g. "document conversion", "test debugging"), (c) avoid vague terms like "when needed" or "when appropriate". Use "When the user [action/request]..." or "When [task type]..." format. Examples: "when the user asks to convert a document to PDF", "when debugging a vitest snapshot failure", "when the user requests to deploy a model gateway". This drives the skill listing's "When to use" line, which is how the model decides to invoke the skill. Never leave it empty.
- content: the complete Markdown body of SKILL.md, following the MANDATORY structure below.
- verification: how to prove the skill earns its place. Required object:
  - triggers: 2-4 short requests a real user would type that SHOULD invoke this skill (e.g. "convert this spreadsheet to a PDF"), written as the user says them — never as descriptions of the skill.
  - negativeTriggers: 1-3 near-miss requests that must NOT invoke it: same topic area, different intent (for a PDF-conversion skill, "summarize this PDF").
  - acceptance: one sentence naming an observable result that shows the skill worked (a file exists, a command passes, a section is present).
- files: optional supporting files (e.g. scripts, data files) relative to the skill directory. Empty array if none.

### MANDATORY SKILL.md structure

Every generated skill MUST follow this exact section structure. Do not omit any section.

\`\`\`markdown
---
name: <kebab-case-name>
description: <one-sentence-purpose>
when-to-use: <specific trigger situations for this skill>
---

# <Title>

## 适用场景

<!-- When to use this skill. List trigger phrases, project types, or situations. -->

## 核心指令

<!-- Step-by-step instructions. Number each step. Mention specific tools by name
(Read, Write, Bash, Agent, Glob, Grep, LSP, etc.). -->

## 示例

<!-- One concrete example grounded in the conversation. Show a realistic
user request and how this skill would handle it. -->

## 质量检查清单

<!-- 3-5 checklist items the agent should verify before considering the task done. -->
- [ ] ...
- [ ] ...
\`\`\`

Rules:
- The skill must be reusable across similar projects, not hard-coded to the current session.
- Mention tools by name (Read, Bash, Agent, etc.) when giving step-by-step instructions.
- Use placeholders like <entry-file> instead of project-specific paths when possible.
- Do not invent file content the user did not provide.
- Match the user's language (Chinese or English) throughout the SKILL.md content.
- Output ONLY a single fenced JSON block. No extra prose.`;

const MAX_HISTORY_MESSAGES = 40;
const MAX_TEXT_LENGTH = 800;
const MAX_TRANSCRIPT_LENGTH = 12000;

export class MakeSkillPlanTool implements BuiltinTool<MakeSkillPlanInput> {
  readonly name = 'MakeSkillPlan' as const;
  readonly description =
    'Analyze the current conversation context and produce a reusable Scream Code Skill package ' +
    '(SKILL.md plus optional supporting files). Only call this when the user has invoked /make-skill.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MakeSkillPlanInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MakeSkillPlanInput): ToolExecution {
    return {
      description: `Crafting skill plan (${args.type})`,
      approvalRule: this.name,
      execute: (context) => this.execute(args, context),
    };
  }

  private async execute(
    args: MakeSkillPlanInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const plan = await this.generatePlan(args);
      return { output: JSON.stringify(plan, null, 2) };
    } catch (error) {
      if (error instanceof ScreamError) {
        return { isError: true, output: error.message };
      }
      return {
        isError: true,
        output: `Failed to craft skill plan: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async generatePlan(args: MakeSkillPlanInput): Promise<SkillPlan> {
    const transcript = buildTranscript(this.agent.context.history);
    const userPrompt = buildUserPrompt(args, transcript);

    const response = await this.agent.generateWithRetry(
      this.agent.config.provider,
      SYSTEM_PROMPT,
      [],
      [
        {
          role: 'user',
          content: [{ type: 'text', text: userPrompt }],
          toolCalls: [],
        },
      ],
    );

    const rawText =
      typeof response.message.content === 'string'
        ? response.message.content
        : response.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

    const plan = parsePlanJson(rawText);
    validateSkillPlan(plan, args.nameHint);
    return {
      ...plan,
      verification: {
        ...plan.verification,
        instructions: buildVerificationInstructions(plan.verification),
      },
    };
  }
}

function buildUserPrompt(args: MakeSkillPlanInput, transcript: string): string {
  const template = TEMPLATES[args.type];
  const nameHintLine =
    args.nameHint.trim().length > 0
      ? `Suggested name (kebab-case, optional): ${sanitizeSkillName(args.nameHint)}`
      : 'Suggested name (kebab-case, optional): (none)';
  return [
    `## Skill type: ${args.type}`,
    template,
    '## User guidance',
    `- ${nameHintLine}`,
    `- Purpose / problem this skill solves: ${args.purpose.trim().length > 0 ? args.purpose : '(not specified)'}`,
    `- Focus / what to emphasize: ${args.focus.trim().length > 0 ? args.focus : '(not specified)'}`,
    '## Conversation transcript',
    transcript,
  ].join('\n\n');
}

function buildTranscript(history: readonly ContextMessage[]): string {
  const entries: string[] = [];
  for (const message of history.slice(-MAX_HISTORY_MESSAGES)) {
    if (message.origin?.kind === 'injection') continue;

    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .slice(0, MAX_TEXT_LENGTH);
    if (text.length === 0) continue;

    const label = message.role === 'tool' ? 'tool_result' : message.role;
    entries.push(`[${label}]\n${text}`);
  }

  let transcript = entries.join('\n\n');
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_LENGTH);
    const firstBreak = transcript.indexOf('\n\n');
    if (firstBreak > 0) {
      transcript = `[... earlier messages truncated ...]\n\n${transcript.slice(firstBreak + 2)}`;
    }
  }
  return transcript;
}

function parsePlanJson(rawText: string): SkillPlan {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(rawText);
  const jsonText = match?.[1]?.trim() ?? rawText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `The skill plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The SYSTEM_PROMPT instructs the model to emit `when-to-use` (matching the
  // SKILL.md frontmatter), but the internal schema uses camelCase `whenToUse`.
  // Accept all three spellings so the model's hyphenated key parses instead of
  // failing validation. Mirrors the frontmatter aliases in skill/parser.ts.
  const normalizeWhenToUse = (raw: unknown): unknown => {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj['whenToUse'] === undefined) {
        const hyphen = obj['when-to-use'];
        const underscore = obj['when_to_use'];
        if (typeof hyphen === 'string') obj['whenToUse'] = hyphen;
        else if (typeof underscore === 'string') obj['whenToUse'] = underscore;
      }
    }
    return raw;
  };

  const planSchema = z
    .object({
      name: z.string(),
      description: z.string(),
      whenToUse: z.string(),
      content: z.string(),
      verification: z.preprocess(
        // `null` means "nothing to say" to most models; treat it as absent so
        // the actionable "needs verification.triggers" error fires instead of a
        // raw shape error.
        (value) => value ?? undefined,
        z
          .object({
            // A single string is the common near-miss; normalize it to a
            // one-element list so the count check reports "needs 2-4" instead
            // of dumping a zod issue.
            triggers: z.preprocess(
              (value) => (typeof value === 'string' ? [value] : value),
              z.array(z.string()).default([]),
            ),
            negativeTriggers: z.preprocess(
              (value) => (typeof value === 'string' ? [value] : value),
              z.array(z.string()).default([]),
            ),
            acceptance: z.string().default(''),
            instructions: z.string().default(''),
          })
          .default({ triggers: [], negativeTriggers: [], acceptance: '', instructions: '' }),
      ),
      files: z
        .array(
          z.object({
            path: z.string(),
            content: z.string(),
          }),
        )
        .default([]),
    })
    .transform((plan) => plan);

  const result = z.preprocess(normalizeWhenToUse, planSchema).safeParse(parsed);

  if (!result.success) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `The skill plan has an invalid structure: ${result.error.message}`,
    );
  }

  return result.data;
}

function validateSkillPlan(plan: SkillPlan, nameHint: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.name)) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Generated skill name "${plan.name}" is not kebab-case. Please regenerate.`,
    );
  }

  if (nameHint.trim().length > 0) {
    const normalizedHint = sanitizeSkillName(nameHint);
    if (plan.name !== normalizedHint) {
      throw new ScreamError(
        ErrorCodes.REQUEST_INVALID,
        `Generated skill name "${plan.name}" does not match the user's requested name "${normalizedHint}". Please use the requested name.`,
      );
    }
  }

  if (plan.whenToUse.trim().length === 0) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      'Generated skill plan is missing the required "whenToUse" field. Describe the specific situations that should trigger this skill with concrete trigger conditions (e.g. "when the user asks to convert a document to PDF") — it powers the skill listing\'s "When to use" line.',
    );
  }

  let parsedSkill;
  try {
    parsedSkill = parseSkillText({
      skillMdPath: `/builtin/skills/${plan.name}.md`,
      skillDirName: plan.name,
      source: 'user',
      text: plan.content,
    });
  } catch (error) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Generated SKILL.md is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The installed SKILL.md's own frontmatter must carry when-to-use (the plan
  // JSON field above is only an authoring hint; what actually powers the
  // listing's "When to use" line is the parsed content frontmatter).
  const contentWhenToUse = parsedSkill.metadata.whenToUse;
  if (typeof contentWhenToUse !== 'string' || contentWhenToUse.trim().length === 0) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      'Generated SKILL.md is missing the required "when-to-use" frontmatter field. Add 1-2 sentences describing the specific situations that should trigger this skill (it powers the skill listing\'s "When to use" line).',
    );
  }

  // Last check on purpose: a plan that is already broken elsewhere should report
  // that first, and the verification block is the least structural of the fields.
  validateVerification(plan.verification);
}

/**
 * Weighted length, not character count: a CJK request says as much in six
 * glyphs as an English one does in twelve ("转成 PDF" vs "convert to PDF").
 * Counting characters alone would reject every short Chinese trigger.
 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function requestWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += WIDE_CHAR.test(char) ? 2 : 1;
  return weight;
}

/** Below this the "request" is filler ("do it", "需要时"); two CJK glyphs weigh 4. */
const MIN_TRIGGER_WEIGHT = 4;
/** An acceptance has to name something observable: "it works" fails, "文件已生成" passes. */
const MIN_ACCEPTANCE_WEIGHT = 10;
const VAGUE_TRIGGER =
  /^(when needed|when appropriate|as needed|do it|help me|run it|fix it|make it|n\/a|none|any|todo|tbd|需要时|按需|看情况|随便|暂无|测试|待定)$/i;

/**
 * Words that can pad any sentence without naming a result: after removing them
 * (and punctuation) almost nothing may remain, or the acceptance is a promise
 * nobody can check — "It works as expected." weighs 21 but says nothing.
 */
const VACUOUS_FILLER =
  /\b(it|the|a|an|skill|works?|working|fine|ok|okay|good|as|expected|correctly|well|no|problems?|just|does|do|should|be)\b/gi;
const CJK_FILLER = /没问题|能正常工作|正常工作|可以了|就行了|没毛病|正常|可用|能用/g;

function isVacuousAcceptance(text: string): boolean {
  const rest = text
    .replaceAll(VACUOUS_FILLER, ' ')
    .replaceAll(CJK_FILLER, ' ')
    .replaceAll(/[\s.,;:!?'"`。，、；：！？（）()]/g, '');
  return rest.length < 4;
}

function validateVerification(verification: PlanVerification): void {
  const triggers = verification.triggers.map((item) => item.trim()).filter((item) => item.length > 0);
  const negatives = verification.negativeTriggers
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const acceptance = verification.acceptance.trim();

  if (triggers.length < 2) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      'Generated skill plan needs verification.triggers with 2-4 requests a real user would type that should invoke this skill (e.g. "convert this spreadsheet to a PDF"). Descriptions of the skill do not count.',
    );
  }
  if (triggers.length > 4) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Generated skill plan has ${String(triggers.length)} triggers; keep at most 4 so the trigger test stays runnable.`,
    );
  }
  const uniqueTriggers = new Set(triggers.map((item) => item.toLowerCase()));
  if (uniqueTriggers.size !== triggers.length) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      'Generated skill plan repeats the same trigger. Each trigger must be a different request a real user might send.',
    );
  }
  const weakTrigger = triggers.find(
    (item) => requestWeight(item) < MIN_TRIGGER_WEIGHT || VAGUE_TRIGGER.test(item),
  );
  if (weakTrigger !== undefined) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Trigger "${weakTrigger}" is too short or too generic to test with. Write the request the user would actually type, including what they would name (a file, a task, a symptom).`,
    );
  }

  if (negatives.length === 0) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      'Generated skill plan needs verification.negativeTriggers with at least 1 near-miss request that must NOT invoke this skill — same topic area, different intent (for a PDF-conversion skill: "summarize this PDF").',
    );
  }
  if (negatives.length > 3) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Generated skill plan has ${String(negatives.length)} negative triggers; keep at most 3.`,
    );
  }
  const positiveSet = new Set(triggers.map((item) => item.toLowerCase()));
  const duplicate = negatives.find((item) => positiveSet.has(item.toLowerCase()));
  if (duplicate !== undefined) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Negative trigger "${duplicate}" duplicates a positive trigger. A near miss must have a different intent, not the same request.`,
    );
  }
  const weakNegative = negatives.find(
    (item) => requestWeight(item) < MIN_TRIGGER_WEIGHT || VAGUE_TRIGGER.test(item),
  );
  if (weakNegative !== undefined) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      `Negative trigger "${weakNegative}" is too short or too generic to be a useful near miss. Name a related request with a different intent.`,
    );
  }

  if (requestWeight(acceptance) < MIN_ACCEPTANCE_WEIGHT || isVacuousAcceptance(acceptance)) {
    throw new ScreamError(
      ErrorCodes.REQUEST_INVALID,
      'Generated skill plan needs verification.acceptance: one sentence naming an observable result that shows the skill worked (a file exists, a command passes, a section is present).',
    );
  }
}

function buildVerificationInstructions(verification: PlanVerification): string {
  const quoted = (items: readonly string[]): string =>
    items
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => `"${item}"`)
      .join(', ');
  return (
    `Test after install — should trigger: ${quoted(verification.triggers)}; ` +
    `should NOT trigger: ${quoted(verification.negativeTriggers)}. ` +
    `Acceptance: ${verification.acceptance.trim()}`
  );
}
