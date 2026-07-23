import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
} as const;

describe('default agent profiles', () => {
  it('loads the bundled default system prompt from embedded sources', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext);

    expect(prompt).toContain('You are Scream Code');
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('/workspace');
  });

  it('bundles the writer as a full document-production specialist', () => {
    const writer = DEFAULT_AGENT_PROFILES['writer'];
    const prompt = writer?.systemPrompt(promptContext);

    expect(writer?.description).toContain('document specialist');
    expect(writer?.tools).toEqual(
      expect.arrayContaining(['Read', 'ReadMediaFile', 'Write', 'Edit', 'Bash', 'WebSearch', 'FetchURL']),
    );
    expect(prompt).toContain('full document lifecycle');
    expect(prompt).toContain('If the caller requests a file, create or edit the actual file');
    expect(prompt).toContain('DOCX');
    expect(prompt).toContain('translation');
    expect(prompt).toContain('Quality assurance before handoff');
    expect(prompt).not.toContain('Your only output is Markdown content');
    expect(prompt).not.toContain('Start every substantial piece with a "Why This Matters" section');
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });
});
