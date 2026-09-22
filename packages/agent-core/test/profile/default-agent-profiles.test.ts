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
    const names = ['coder', 'explore', 'plan', 'verify', 'reviewer', 'oracle', 'worker', 'writer', 'designer'];
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
    const names = ['coder', 'explore', 'plan', 'verify', 'reviewer', 'oracle', 'worker', 'writer', 'designer'];
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
    expect(prompt).not.toMatch(/^- `(coder|explore|plan|verify|reviewer|oracle|worker|writer|designer)` — /m);
  });

  it('exposes the bundled subagents through the derived roster', () => {
    const roster = subagentRoster();
    const names = roster.map((entry) => entry.name);

    // Membership and order follow agent.yaml's `subagents:` map exactly — the
    // sidebar and the /model diy binder both read this, so a hand-written
    // second list cannot drift from it.
    expect(names).toEqual(Object.keys(DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {}));
    expect(names).toContain('oracle');
    expect(names).toContain('designer');
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

  it('gives designer one fused job: own the visual layer end to end', () => {
    const designer = DEFAULT_AGENT_PROFILES['designer'];
    const prompt = designer?.systemPrompt(promptContext) ?? '';

    // A producer with its own spawns — specs are written into the codebase.
    expect(designer?.tools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'ReadMediaFile', 'Agent', 'LSP', 'KnowledgeLookup']),
    );
    expect(designer?.spawns).toEqual(['explore']);

    // One job at three entry points, not three jobs.
    expect(prompt).toContain('One job, three entry points');
    for (const entry of ['Direction', 'Spec & Apply', 'Audit']) {
      expect(prompt, `entry ${entry}`).toContain(entry);
    }

    // The method vocabulary must survive verbatim.
    expect(prompt).toContain('Pick the track first');
    expect(prompt).toContain('Fit before diversity');
    expect(prompt).toContain('Vague-word firewall');
    expect(prompt).toContain('Code-grade specs');
    expect(prompt).toContain('Meta-check');
    for (const dial of ['Energy', 'Finish', 'Density', 'Weight', 'Playfulness']) {
      expect(prompt, `dial ${dial}`).toContain(dial);
    }

    // TUI is a first-class medium, not an afterthought.
    expect(prompt).toContain('Terminal (TUI)');
    expect(prompt).toContain('Width budget');
    expect(prompt).toContain('CJK double-width');

    // Collaboration contract — the same preamble every specialist carries.
    expect(prompt).toContain('[parent_messages]');
    expect(prompt).toContain('ContactParent');
    expect(prompt).toContain('restricted capability mode');

    // Boundaries keep the seam with coder / verify / reviewer / oracle.
    expect(prompt).toContain('You own the visual layer only');
    expect(prompt).toContain('You do not run gates');
    expect(prompt).toContain('You do not review diffs for correctness');
    // A producer, not a spec-only advisor: the prompt must say the specs get
    // written into the codebase.
    expect(prompt).toContain('you produce design specs AND write them into styles');
    // Structured close the parent can parse, same spirit as oracle's block.
    for (const field of ['Verdict:', 'Confidence:', 'Spec:', 'Files:']) {
      expect(prompt, `output field ${field}`).toContain(field);
    }

    // Routing contract: USE WHEN / NOT FOR plus the roster description.
    expect(designer?.whenToUse).toContain('USE WHEN:');
    expect(designer?.whenToUse).toContain('NOT FOR:');
    for (const sibling of ['coder', 'plan', 'writer', 'worker', 'verify', 'reviewer', 'oracle']) {
      expect(designer?.whenToUse, `NOT FOR sibling ${sibling}`).toContain(sibling);
    }
    const description = DEFAULT_AGENT_PROFILES['agent']?.subagents?.['designer']?.description ?? '';
    expect(description).toContain('Visual-layer');
    expect(description).toContain('UI/UX/TUI');

    // The lead agent's condition->delegate table must route visual work here.
    expect(prompt).toContain('The deliverable is visual quality');
    expect(prompt).toContain('`designer` owns the visual layer');
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });
});
