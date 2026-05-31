/**
 * Windows-only: default Node `kill` does not stop the whole process tree, so
 * background Bash can leave orphaned child processes. Once tree kill lands
 * (e.g. `taskkill /T`), assert grandchildren are reaped within the grace window.
 */
import { describe, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('BashTool background — Windows kill tree', () => {
  it.todo('stop() terminates grandchild processes via taskkill /T');
});
