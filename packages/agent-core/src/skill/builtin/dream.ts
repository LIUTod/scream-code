import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import DREAM_BODY from './dream.md';

const PSEUDO_PATH = 'builtin://dream';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/dream.md',
  skillDirName: 'dream',
  source: 'builtin',
  text: DREAM_BODY,
});

export const DREAM_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
