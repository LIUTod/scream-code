import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';
import { subagentRoster } from '../../src/profile/roster';
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

  it('exposes the bundled subagents through the derived roster', () => {
    const roster = subagentRoster();
    const names = roster.map((entry) => entry.name);

    // Membership and order follow agent.yaml's `subagents:` map exactly — the
    // sidebar and the /model diy binder both read this, so a hand-written
    // second list cannot drift from it.
    expect(names).toEqual(Object.keys(DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {}));
    expect(names).toContain('oracle');
    for (const entry of roster) {
      expect(entry.description.length, `empty description for ${entry.name}`).toBeGreaterThan(0);
    }
  });

  it('gives oracle one fused job: a large-scope review of what is wrong with existing code', () => {
    const oracle = DEFAULT_AGENT_PROFILES['oracle'];
    const prompt = oracle?.systemPrompt(promptContext) ?? '';

    expect(oracle?.tools).toEqual(expect.arrayContaining(['ReportArchFinding', 'Agent', 'Grep', 'LSP']));
    expect(oracle?.tools).not.toContain('ReportFinding');
    expect(oracle?.spawns).toEqual(['explore']);

    // One job at two scales, not two jobs. The old split (a root-cause job and
    // an audit job) must not come back — the caller's four questions are one
    // review, and this is the larger-scope counterpart of a patch review.
    expect(prompt).toContain('You are a reviewer at the larger scale');
    expect(prompt).toContain('same review at different scales');
    expect(prompt).not.toContain('Job A');
    expect(prompt).not.toContain('Job B');
    expect(prompt).not.toContain('structural audit');
    expect(prompt).not.toContain('second opinion');
    // The pre-fusion triggers must stay gone: those were the second job. (The
    // generic "find the root cause" advice in system.md's coding guidance is
    // the lead agent's, not a routing trigger — only the triggers are banned.)
    expect(prompt).not.toContain('two approaches look equally valid');
    expect(prompt).not.toContain('the root cause is still unclear');
    expect(oracle?.whenToUse).not.toContain('root cause');

    // The caller's four questions must survive verbatim.
    expect(prompt).toContain('Is the architecture reasonable?');
    expect(prompt).toContain('Is there tech debt?');
    expect(prompt).toContain('Will long-term changes stay hard to maintain?');
    expect(prompt).toContain('Is there useless, invalid, or redundant code?');

    // A reported symptom or ugly area is scoped review, not a fifth category.
    expect(prompt).toContain('not a fifth category');
    expect(prompt).toContain('ReportArchFinding');
    expect(prompt).toContain('Verdict:');
    // Quantified outcome — the count of deletions/inlines and the lines they
    // recover, so the parent can weigh a cleanup against the churn of doing it.
    expect(prompt).toContain('Net:');

    // The tag vocabulary must survive verbatim — a reword breaks the tool schema.
    for (const tag of ['dead', 'dup', 'wrong-layer', 'over-build', 'under-build', 'debt', 'portable']) {
      expect(prompt, `tag ${tag}`).toContain(tag);
    }
    expect(oracle?.whenToUse).toContain('large-scope review of code that already exists');
    expect(oracle?.whenToUse).toContain('same activity at line scale');
    expect(oracle?.whenToUse).toContain('NOT FOR:');

    // The parent's first look is agent.yaml's `subagents:` description. It must
    // name the job, not the old "deep debugging" role.
    const description = DEFAULT_AGENT_PROFILES['agent']?.subagents?.['oracle']?.description ?? '';
    expect(description).toContain('Large-scope review of code that already exists');
    expect(description).toContain('architecture soundness');
    expect(description).toContain('tech debt');
    expect(description).toContain('long-term maintainability');
    expect(description).not.toContain('Deep debugging');

    // The lead agent's condition->delegate table must route the job here too,
    // and its orientation line must pair oracle with reviewer as two scales.
    expect(prompt).toContain('You need a large-scope review of code that already exists');
    expect(prompt).toContain('`oracle` reviews existing code at system scale');
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });
});
