import { describe, expect, it } from 'vitest';

import { getSubagentProfiles } from '#/tui/components/dialogs/subagent-model-binder';
import { DEFAULT_SUBAGENT_TYPES } from '#/tui/utils/subagent-slots';

/**
 * The picker keeps its own row order, so these tests pin both halves of the
 * contract: the order users expect here, and membership that follows the shared
 * slot list (a profile added there can never go missing in this dialog).
 */
describe('subagent model binder rows', () => {
  it('renders every shared subagent type in the picker order', () => {
    const names = getSubagentProfiles().map((row) => row.name);

    expect(names).toEqual([
      'coder',
      'reviewer',
      'writer',
      'explore',
      'oracle',
      'plan',
      'verify',
      'worker',
    ]);
  });

  it('never drops a type the shared slot list knows about', () => {
    const shown = new Set(getSubagentProfiles().map((row) => row.name));

    for (const type of DEFAULT_SUBAGENT_TYPES) {
      expect(shown.has(type), `missing picker row for ${type}`).toBe(true);
    }
    expect(shown.size).toBe(DEFAULT_SUBAGENT_TYPES.length);
  });

  it('gives every row a label to render', () => {
    for (const row of getSubagentProfiles()) {
      expect(row.description.length, `empty description for ${row.name}`).toBeGreaterThan(0);
    }
  });
});