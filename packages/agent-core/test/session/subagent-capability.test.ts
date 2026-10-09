import { describe, expect, it } from 'vitest';
import {
  filterToolsForCapability,
  isToolAllowedForCapability,
} from '../../src/session/subagent-capability';

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

  it('strips unknown tool names in restricted modes (fail closed)', () => {
    const withUnknown = [...FULL, 'FutureToolX'];
    for (const mode of ['read-only', 'read-write', 'execute'] as const) {
      expect(filterToolsForCapability(withUnknown, mode), mode).not.toContain('FutureToolX');
    }
    expect(filterToolsForCapability(withUnknown, 'all')).toContain('FutureToolX');
  });

  it('strips MCP tools in restricted modes (fail closed)', () => {
    const withMcp = [...FULL, 'mcp__chrome_devtools__navigate'];
    for (const mode of ['read-only', 'read-write', 'execute'] as const) {
      expect(filterToolsForCapability(withMcp, mode)).not.toContain('mcp__chrome_devtools__navigate');
    }
    expect(filterToolsForCapability(withMcp, 'all')).toContain('mcp__chrome_devtools__navigate');
  });
});

describe('isToolAllowedForCapability', () => {
  it('is the membership test the filter and the permission gate share', () => {
    for (const name of FULL) {
      for (const mode of ['read-only', 'read-write', 'execute'] as const) {
        expect(isToolAllowedForCapability(name, mode), `${name}@${mode}`).toBe(
          filterToolsForCapability([name], mode).length === 1,
        );
      }
    }
  });

  it('fails closed for unclassified tool names in every restricted mode', () => {
    for (const mode of ['read-only', 'read-write', 'execute'] as const) {
      expect(isToolAllowedForCapability('FutureToolX', mode), mode).toBe(false);
      expect(isToolAllowedForCapability('mcp__db__query', mode), mode).toBe(false);
    }
    expect(isToolAllowedForCapability('FutureToolX', 'all')).toBe(true);
    expect(isToolAllowedForCapability('Bash', 'all')).toBe(true);
  });
});
