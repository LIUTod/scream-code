import { z } from 'zod';

import type { Agent } from '#/agent';
import { ScreamError } from '#/errors';
import type { BuiltinTool } from '../../../agent/tool';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import {
  sanitizeSkillName,
  type SkillPackage,
} from './skill-package-writer';
import { writePluginSkillPackage } from './plugin-skill-package-writer';

const SkillPackageFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const MakeSkillApplyInputSchema = z.object({
  name: z.string().describe('Kebab-case skill name.'),
  description: z.string().describe('One-sentence skill description.'),
  content: z.string().describe('Full SKILL.md content including YAML frontmatter.'),
  files: z.array(SkillPackageFileSchema).default([]).describe('Optional supporting files.'),
});

export type MakeSkillApplyInput = z.infer<typeof MakeSkillApplyInputSchema>;

export class MakeSkillApplyTool implements BuiltinTool<MakeSkillApplyInput> {
  readonly name = 'MakeSkillApply' as const;
  readonly description =
    'Write a generated skill package to the plugin center so it can be managed and uninstalled via /plugin. ' +
    'Only call this after the user has explicitly confirmed the plan shown by MakeSkillPlan. ' +
    'Fails if a skill with the same name already exists.';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MakeSkillApplyInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: MakeSkillApplyInput): ToolExecution {
    return {
      description: `Installing skill "${sanitizeSkillName(args.name)}" to plugin center`,
      approvalRule: this.name,
      execute: (context) => this.execute(args, context),
    };
  }

  private async execute(
    args: MakeSkillApplyInput,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const screamHomeDir = this.agent.screamHomeDir;
      if (screamHomeDir === undefined) {
        return {
          isError: true,
          output: 'Cannot install skill: scream home directory is not configured.',
        };
      }

      const pkg: SkillPackage = {
        name: args.name,
        description: args.description,
        content: args.content,
        files: args.files ?? [],
      };

      const result = await writePluginSkillPackage({
        jian: this.agent.jian,
        screamHomeDir,
        manager: this.agent.toolServices?.plugins,
        package: pkg,
      });

      // Hot-apply: the generated skill registers with the shared plugin table,
      // so push it into the running session instead of waiting for the next
      // launch. Skill data only — the generated package has no code entry.
      const sync = this.agent.toolServices?.pluginSync;
      let hotApplied = false;
      if (sync !== undefined) {
        try {
          const report = await sync([result.pluginId], { skipMcpAdd: true });
          hotApplied = report.ok || report.applied.length > 0;
        } catch {
          // Advisory: the skill is installed; the next session loads it anyway.
        }
      }

      return {
        output: `Skill installed to ${result.targetDir}\n\n` +
          `You can manage it in the Skill Center with /plugin, and invoke it with /${sanitizeSkillName(args.name)}` +
          (hotApplied ? ' right away — it was hot-applied to this session.' : ' in a new session.'),
      };
    } catch (error) {
      if (error instanceof ScreamError) {
        return { isError: true, output: error.message };
      }
      return {
        isError: true,
        output: `Failed to install skill: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
