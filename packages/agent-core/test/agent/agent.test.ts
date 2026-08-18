import { describe, expect, it } from 'vitest';

import { testAgent } from './harness/agent';

describe('Agent.services manifest', () => {
  it('exposes the core subsystems with stable references', () => {
    const ctx = testAgent();
    ctx.configure();
    const { services } = ctx.agent;

    expect(services.records).toBe(ctx.agent.records);
    expect(services.context).toBe(ctx.agent.context);
    expect(services.config).toBe(ctx.agent.config);
    expect(services.turn).toBe(ctx.agent.turn);
    expect(services.injection).toBe(ctx.agent.injection);
    expect(services.permission).toBe(ctx.agent.permission);
    expect(services.planMode).toBe(ctx.agent.planMode);
    expect(services.usage).toBe(ctx.agent.usage);
    expect(services.tools).toBe(ctx.agent.tools);
    expect(services.skills).toBe(ctx.agent.skills);
    expect(services.background).toBe(ctx.agent.background);
    expect(services.goal).toBe(ctx.agent.goal);
    expect(services.sessionMemory).toBe(ctx.agent.sessionMemory);
    expect(services.workingSet).toBe(ctx.agent.workingSet);
    expect(services.fullCompaction).toBe(ctx.agent.fullCompaction);
    expect(services.microCompaction).toBe(ctx.agent.microCompaction);
  });

  it('resolves the runtime system prompt through the manifest', () => {
    const ctx = testAgent();
    ctx.configure();
    expect(ctx.agent.services.systemPrompt()).toBe(ctx.agent.getRuntimeSystemPrompt());
  });
});
