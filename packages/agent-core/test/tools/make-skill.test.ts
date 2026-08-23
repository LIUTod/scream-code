import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { LocalJian } from '@scream-code/jian';
import type { Agent } from '../../src/agent';
import type { ContextMessage } from '../../src/agent/context';
import type { ExecutableTool } from '../../src/loop';
import { ScreamError } from '../../src/errors';
import { PluginManager } from '../../src/plugin/manager';
import { MakeSkillApplyTool } from '../../src/tools/builtin/skill/make-skill-apply';
import { MakeSkillPlanTool } from '../../src/tools/builtin/skill/make-skill-plan';
import {
  sanitizeSkillName,
  writeSkillPackage,
} from '../../src/tools/builtin/skill/skill-package-writer';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
let callCounter = 0;

function runTool<Input>(tool: ExecutableTool<Input>, args: Input) {
  return executeTool(tool, {
    args,
    turnId: '1',
    toolCallId: `call_${++callCounter}`,
    signal,
  });
}

function makeContextMessage(role: ContextMessage['role'], text: string): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function validPlanJson(): string {
  return JSON.stringify({
    name: 'react-form-validate',
    description: 'Use zod and react-hook-form to build form validation.',
    whenToUse: 'When the user needs form validation with react-hook-form or zod.',
    content:
      '---\n' +
      'name: react-form-validate\n' +
      'description: Use zod and react-hook-form to build form validation.\n' +
      'when-to-use: When the user needs form validation with react-hook-form or zod.\n' +
      'type: inline\n' +
      '---\n' +
      '\n' +
      '# React form validation\n' +
      '\n' +
      'When the user asks for form validation in React, use zod + react-hook-form.\n',
    files: [
      {
        path: 'check-deps.sh',
        content: '#!/bin/bash\necho "checking deps"\n',
      },
    ],
  });
}

async function makeJian(cwd: string): Promise<LocalJian> {
  const base = await LocalJian.create();
  return base.withCwd(cwd);
}

describe('sanitizeSkillName', () => {
  it('keeps valid kebab-case names', () => {
    expect(sanitizeSkillName('react-form-validate')).toBe('react-form-validate');
  });

  it('lower-cases and converts spaces to hyphens', () => {
    expect(sanitizeSkillName('React Form Validate')).toBe('react-form-validate');
  });

  it('rejects empty names', () => {
    expect(() => sanitizeSkillName('')).toThrow(ScreamError);
  });

  it('rejects names that only become empty after cleaning', () => {
    expect(() => sanitizeSkillName('---')).toThrow(ScreamError);
  });
});

describe('writeSkillPackage', () => {
  it('writes SKILL.md and supporting files under the user scope', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);

    const result = await writeSkillPackage({
      jian,
      package: {
        name: 'test-skill',
        description: 'A test skill.',
        content:
          '---\nname: test-skill\ndescription: A test skill.\ntype: inline\n---\n\n# Test\n',
        files: [{ path: 'helper.txt', content: 'helper content' }],
      },
      scope: 'user',
      userHomeDir: tmp,
      workDir: tmp,
    });

    expect(result.targetDir).toBe(join(tmp, '.scream-code', 'skills', 'test-skill'));
    const skillMd = await jian.readText(join(result.targetDir, 'SKILL.md'));
    expect(skillMd).toContain('name: test-skill');
    const helper = await jian.readText(join(result.targetDir, 'helper.txt'));
    expect(helper).toBe('helper content');
  });

  it('refuses to overwrite an existing skill', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);

    const pkg = {
      name: 'dup-skill',
      description: 'First.',
      content:
        '---\nname: dup-skill\ndescription: First.\ntype: inline\n---\n\n# First\n',
      files: [],
    };

    await writeSkillPackage({ jian, package: pkg, scope: 'user', userHomeDir: tmp, workDir: tmp });
    await expect(
      writeSkillPackage({ jian, package: pkg, scope: 'user', userHomeDir: tmp, workDir: tmp }),
    ).rejects.toThrow(ScreamError);
  });

  it('rejects supporting files that escape the skill directory', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);

    await expect(
      writeSkillPackage({
        jian,
        package: {
          name: 'escape-skill',
          description: 'Bad.',
          content:
            '---\nname: escape-skill\ndescription: Bad.\ntype: inline\n---\n\n# Bad\n',
          files: [{ path: '../escape.txt', content: 'should not write' }],
        },
        scope: 'user',
        userHomeDir: tmp,
        workDir: tmp,
      }),
    ).rejects.toThrow(ScreamError);
  });
});

describe('MakeSkillPlanTool', () => {
  it('returns a parsed plan when the LLM produces valid JSON', async () => {
    const agent = {
      context: {
        history: [
          makeContextMessage('user', 'How do I validate a React form?'),
          makeContextMessage(
            'assistant',
            'Use zod to define a schema and react-hook-form to bind it.',
          ),
        ],
      },
      config: { provider: {} as unknown as Parameters<Agent['generate']>[0] },
      generateWithRetry: vi.fn().mockResolvedValue({
        message: { content: validPlanJson() },
      }),
    } as unknown as Agent;

    const tool = new MakeSkillPlanTool(agent);
    const result = await runTool(tool, {
      type: 'code-pattern',
      nameHint: '',
      purpose: 'Validate React forms with zod.',
      focus: 'Extract the validation pattern and error handling.',
    });

    expect(result.isError).not.toBe(true);
    const plan = JSON.parse(typeof result.output === 'string' ? result.output : '');
    expect(plan.name).toBe('react-form-validate');
    expect(plan.files).toHaveLength(1);
    expect(agent.generateWithRetry).toHaveBeenCalledTimes(1);
  });

  it('returns an error when the LLM response is not valid JSON', async () => {
    const agent = {
      context: { history: [makeContextMessage('user', 'Hi')] },
      config: { provider: {} as unknown as Parameters<Agent['generate']>[0] },
      generateWithRetry: vi.fn().mockResolvedValue({
        message: { content: 'not json' },
      }),
    } as unknown as Agent;

    const tool = new MakeSkillPlanTool(agent);
    const result = await runTool(tool, {
      type: 'workflow',
      nameHint: '',
      purpose: '',
      focus: '',
    });

    expect(result.isError).toBe(true);
  });

  it('accepts a plan whose top-level JSON uses the hyphenated when-to-use key', async () => {
    const agent = {
      context: { history: [makeContextMessage('user', 'How do I deploy a gateway?')] },
      config: { provider: {} as unknown as Parameters<Agent['generate']>[0] },
      generateWithRetry: vi.fn().mockResolvedValue({
        message: {
          content: JSON.stringify({
            name: 'gateway-monitor',
            description: 'Monitor a gateway deployment.',
            // The SYSTEM_PROMPT tells the model to emit `when-to-use`, which
            // must be normalized to the internal `whenToUse` before the zod
            // schema validates it (regression: this used to fail validation).
            'when-to-use': 'When the user asks to deploy or monitor a model gateway.',
            content:
              '---\n' +
              'name: gateway-monitor\n' +
              'description: Monitor a gateway deployment.\n' +
              'when-to-use: When the user asks to deploy or monitor a model gateway.\n' +
              'type: inline\n' +
              '---\n' +
              '\n' +
              '# Gateway monitor\n' +
              '\n' +
              'Monitor the gateway deployment.\n',
            files: [],
          }),
        },
      }),
    } as unknown as Agent;

    const tool = new MakeSkillPlanTool(agent);
    const result = await runTool(tool, {
      type: 'tool-chain',
      nameHint: '',
      purpose: '',
      focus: '',
    });

    expect(result.isError).not.toBe(true);
    const plan = JSON.parse(typeof result.output === 'string' ? result.output : '');
    expect(plan.name).toBe('gateway-monitor');
    expect(plan.whenToUse).toBe('When the user asks to deploy or monitor a model gateway.');
  });

  it('rejects a plan whose content frontmatter lacks when-to-use', async () => {
    const agent = {
      context: { history: [makeContextMessage('user', 'Hi')] },
      config: { provider: {} as unknown as Parameters<Agent['generate']>[0] },
      generateWithRetry: vi.fn().mockResolvedValue({
        message: {
          content: JSON.stringify({
            name: 'missing-when-to-use',
            description: 'A skill without trigger guidance.',
            whenToUse: 'Should be used for X.',
            content:
              '---\n' +
              'name: missing-when-to-use\n' +
              'description: A skill without trigger guidance.\n' +
              'type: inline\n' +
              '---\n' +
              '\n' +
              '# Missing\n',
            files: [],
          }),
        },
      }),
    } as unknown as Agent;

    const tool = new MakeSkillPlanTool(agent);
    const result = await runTool(tool, {
      type: 'workflow',
      nameHint: '',
      purpose: '',
      focus: '',
    });

    // The plan JSON has whenToUse, but the SKILL.md content omits the
    // when-to-use frontmatter — validation must catch that (it is what
    // actually powers the listing's "When to use" line).
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('when-to-use');
  });
});

describe('MakeSkillApplyTool', () => {
  it('writes the skill package to the plugin center and reports the target directory', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);
    const agent = { jian, screamHomeDir: tmp } as unknown as Agent;

    const tool = new MakeSkillApplyTool(agent);
    const result = await runTool(tool, {
      name: 'applied-skill',
      description: 'Applied.',
      content:
        '---\nname: applied-skill\ndescription: Applied.\ntype: inline\n---\n\n# Applied\n',
      files: [],
    });

    expect(result.isError).not.toBe(true);
    expect(typeof result.output === 'string' ? result.output : '').toContain(
      join(tmp, 'plugins', 'managed', 'applied-skill'),
    );

    const manager = new PluginManager({ screamHomeDir: tmp });
    await manager.load();
    const summary = manager.summaries().find((s) => s.id === 'applied-skill');
    expect(summary).toBeDefined();
    expect(summary?.skillCount).toBe(1);
    expect(summary?.enabled).toBe(true);
  });

  it('returns an error when the skill already exists', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);
    const agent = { jian, screamHomeDir: tmp } as unknown as Agent;

    const args = {
      name: 'existing-skill',
      description: 'Existing.',
      content:
        '---\nname: existing-skill\ndescription: Existing.\ntype: inline\n---\n\n# Existing\n',
      files: [],
    };

    const tool = new MakeSkillApplyTool(agent);
    await runTool(tool, args);

    const second = await runTool(tool, args);

    expect(second.isError).toBe(true);
    expect(typeof second.output === 'string' ? second.output : '').toContain('already exists');
  });

  it('registers the generated skill in the plugin center', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);
    const agent = { jian, screamHomeDir: tmp } as unknown as Agent;

    const tool = new MakeSkillApplyTool(agent);
    await runTool(tool, {
      name: 'registered-skill',
      description: 'Registered.',
      content:
        '---\nname: registered-skill\ndescription: Registered.\ntype: inline\n---\n\n# Registered\n',
      files: [],
    });

    const manager = new PluginManager({ screamHomeDir: tmp });
    await manager.load();
    const record = manager.get('registered-skill');
    expect(record).toBeDefined();
    expect(record?.enabled).toBe(true);
    expect(record?.manifest?.skills?.length).toBe(1);
  });

  it('installs when files is omitted', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'make-skill-test-'));
    const jian = await makeJian(tmp);
    const agent = { jian, screamHomeDir: tmp } as unknown as Agent;

    const tool = new MakeSkillApplyTool(agent);
    const result = await runTool(tool, {
      name: 'no-files-skill',
      description: 'No files.',
      content:
        '---\nname: no-files-skill\ndescription: No files.\ntype: inline\n---\n\n# No files\n',
      files: undefined as unknown as never,
    });

    expect(result.isError).not.toBe(true);
    expect(typeof result.output === 'string' ? result.output : '').toContain('Skill installed to');
  });
});
