import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';
import { buildSubagentDescriptions } from '../../src/tools/builtin/collaboration/agent';

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
    expect(prompt).toContain('Self Assets');
    // The {{ SCREAM_SELF_ASSETS }} variable must render real asset content,
    // not stay empty (nunjucks throwOnUndefined would already fail on missing
    // vars, but this pins the rendered value).
    expect(prompt).toContain('memos.sqlite');
    expect(prompt).toContain('knowledge.db');
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

  it('bundles the worker as an office automation specialist', () => {
    const worker = DEFAULT_AGENT_PROFILES['worker'];
    const prompt = worker?.systemPrompt(promptContext);

    expect(worker?.description).toContain('Office');
    expect(worker?.tools).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'KnowledgeLookup']),
    );
    expect(prompt).toContain('OUTPUT ISOLATION');
    expect(prompt).toContain('SAMPLE BEFORE BATCH');
    expect(prompt).toContain('more than 3 files');
    expect(prompt).toContain('REVIEWABLE DELIVERY');
    expect(prompt).toContain('CLEAN FAILURES');
    expect(prompt).toContain('Do not read or modify code files');
    expect(prompt).not.toContain('codebase exploration specialist');
  });

  it('keeps one routing contract per specialist: a description plus USE WHEN / NOT FOR triggers', () => {
    const names = ['coder', 'explore', 'plan', 'verify', 'reviewer', 'oracle', 'worker', 'writer'];
    for (const name of names) {
      const profile = DEFAULT_AGENT_PROFILES[name];
      expect(profile, `missing profile: ${name}`).toBeDefined();
      expect((profile?.description ?? '').length, `${name} description`).toBeGreaterThan(20);
      // The parent chooses a type from these two lines in the Agent tool
      // description; a specialist without triggers is dead weight.
      expect(profile?.whenToUse, `${name} whenToUse`).toContain('USE WHEN:');
      expect(profile?.whenToUse, `${name} whenToUse`).toContain('NOT FOR:');
    }
  });

  it('keeps the specialist roster single-sourced in the Agent tool description', () => {
    const names = ['coder', 'explore', 'plan', 'verify', 'reviewer', 'oracle', 'worker', 'writer'];
    const agent = DEFAULT_AGENT_PROFILES['agent'];

    // The generated roster is the surface the parent actually picks from, so
    // assert on it directly — an empty `subagents:` map must fail here.
    const roster = buildSubagentDescriptions(agent?.subagents ?? {});
    const entries = roster.split('\n').filter((line) => line.startsWith('- '));
    expect(entries).toHaveLength(names.length);
    for (const name of names) {
      expect(roster, `roster line for ${name}`).toContain(`- ${name}:`);
    }

    // The system prompt may only point at that list: a hand-written bullet
    // roster drifts from agent.yaml the moment one side changes.
    const prompt = agent?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain('Available agent types');
    expect(prompt).not.toMatch(/^- `(coder|explore|plan|verify|reviewer|oracle|worker|writer)` — /m);
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });
});
