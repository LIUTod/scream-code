import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import IMAGE_BODY from './image.md';

const PSEUDO_PATH = 'builtin://image';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/image.md',
  skillDirName: 'image',
  source: 'builtin',
  text: IMAGE_BODY,
});

export const IMAGE_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    // Model-invocable on purpose: image intent ("draw / edit this") must
    // activate the skill without a slash command (unlike dream).
  },
};
