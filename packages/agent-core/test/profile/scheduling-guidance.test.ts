/**
 * The main agent is told it can schedule its own follow-ups — and when — instead
 * of being told `/cron` is a user command it cannot run. Subagents have no
 * scheduler, so they get none of it.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../../src/profile';

const promptContext = {
  osEnv: { osKind: 'macOS', osArch: 'arm64', osVersion: '0', shellName: 'bash', shellPath: '/bin/bash' },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
} as const;

const main = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

describe('scheduling guidance in the system prompt', () => {
  it('the main agent gets the section, with when to use it and the rules', () => {
    expect(main).toContain('# Scheduling Follow-ups');
    expect(main).toContain('Do not hold the turn with `sleep` or a polling loop');
    expect(main).toContain('Report every task you create in your reply');
    // Reaching the tools when the portal holds them back.
    expect(main).toContain('`DiscoverTools({ group: "cron" })` enables them');
  });

  it('no longer tells the main agent scheduling is a command it cannot run', () => {
    expect(main).toContain('Scheduling is the exception: you create and manage scheduled tasks yourself');
    // The old capability row pointed the model at `/cron` for recurring work.
    expect(main).not.toContain('`/cron` schedules and manages recurring runs');
  });

  it('subagents, which have no scheduler, get none of it', () => {
    const subagents = DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {};
    expect(Object.keys(subagents).length).toBeGreaterThan(0);
    for (const [name, profile] of Object.entries(subagents)) {
      const prompt = profile?.systemPrompt(promptContext) ?? '';
      expect(prompt, name).not.toContain('# Scheduling Follow-ups');
      expect(prompt, name).not.toContain('Scheduling is the exception');
    }
  });
});
