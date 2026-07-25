import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import TOOL_PROMPT_OPTIMIZATION_BODY from './tool-prompt-optimization/SKILL.md';

const PSEUDO_PATH = 'builtin://tool-prompt-optimization';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/tool-prompt-optimization/SKILL.md',
  skillDirName: 'tool-prompt-optimization',
  source: 'builtin',
  text: TOOL_PROMPT_OPTIMIZATION_BODY,
});

export const TOOL_PROMPT_OPTIMIZATION_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
