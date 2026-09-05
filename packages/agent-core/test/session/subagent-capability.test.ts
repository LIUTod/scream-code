import { describe, expect, it } from 'vitest';
import { filterToolsForCapability } from '../../src/session/subagent-capability';

const FULL = [
  'Read',
  'ReadGroup',
  'Grep',
  'Glob',
  'LSP',
  'WebSearch',
  'ReportFinding',
  'Edit',
  'Write',
  'Bash',
  'Agent',
  'SendSubagentMessage',
  'WolfPack',
  'AskUserQuestion',
  'ExitPlanMode',
];

describe('filterToolsForCapability', () => {
  it('keeps everything for all / undefined', () => {
    expect(filterToolsForCapability(FULL, 'all')).toEqual(FULL);
    expect(filterToolsForCapability(FULL, undefined)).toEqual(FULL);
  });

  it('read-only keeps inspection + collaboration + core, drops write/execute', () => {
    const out = filterToolsForCapability(FULL, 'read-only');
    for (const t of ['Read', 'Grep', 'Glob', 'LSP', 'WebSearch', 'ReportFinding', 'AskUserQuestion']) {
      expect(out).toContain(t);
    }
    for (const t of ['Edit', 'Write', 'Bash', 'Agent', 'SendSubagentMessage']) {
      expect(out).not.toContain(t);
    }
  });

  it('read-write adds Write/Edit but still drops Bash and Agent', () => {
    const out = filterToolsForCapability(FULL, 'read-write');
    expect(out).toContain('Edit');
    expect(out).toContain('Write');
    expect(out).not.toContain('Bash');
    expect(out).not.toContain('Agent');
    expect(out).not.toContain('SendSubagentMessage');
  });

  it('execute keeps Bash but drops nested Agent spawning', () => {
    const out = filterToolsForCapability(FULL, 'execute');
    expect(out).toContain('Bash');
    expect(out).not.toContain('Agent');
    expect(out).not.toContain('SendSubagentMessage');
  });

  it('nesting tools (Agent/SendSubagentMessage/WolfPack) are only available in all mode', () => {
    for (const mode of ['read-only', 'read-write', 'execute'] as const) {
      const out = filterToolsForCapability(FULL, mode);
      expect(out).not.toContain('Agent');
      expect(out).not.toContain('SendSubagentMessage');
      expect(out).not.toContain('WolfPack');
    }
    const all = filterToolsForCapability(FULL, 'all');
    expect(all).toContain('Agent');
    expect(all).toContain('SendSubagentMessage');
    expect(all).toContain('WolfPack');
  });

  it('preserves unknown tool names (fail open)', () => {
    const withUnknown = [...FULL, 'FutureToolX'];
    expect(filterToolsForCapability(withUnknown, 'read-only')).toContain('FutureToolX');
  });

  it('strips MCP tools in restricted modes (fail closed)', () => {
    const withMcp = [...FULL, 'mcp__chrome_devtools__navigate'];
    for (const mode of ['read-only', 'read-write', 'execute'] as const) {
      expect(filterToolsForCapability(withMcp, mode)).not.toContain('mcp__chrome_devtools__navigate');
    }
    expect(filterToolsForCapability(withMcp, 'all')).toContain('mcp__chrome_devtools__navigate');
  });
});
