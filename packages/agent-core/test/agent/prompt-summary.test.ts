/**
 * The approval card's prompt summary: extracted from the last prompt, plain
 * text only, whitespace-collapsed and truncated.
 */

import { expect, it } from 'vitest';

import { testAgent } from './harness/agent';

it('summarizes the last prompt as collapsed plain text', async () => {
  const ctx = testAgent();

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: '  deploy\n the   release  ' }] });
  await ctx.untilTurnEnd();

  expect(ctx.agent.turn.getLastPromptSummary()).toBe('deploy the release');
});

it('truncates a long prompt at the boundary', async () => {
  const ctx = testAgent();
  const long = 'x'.repeat(200);

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: long }] });
  await ctx.untilTurnEnd();

  const summary = ctx.agent.turn.getLastPromptSummary();
  expect(summary).toBe(`${'x'.repeat(120)}…`);
  expect(summary).toHaveLength(121);
});

it('keeps the whole prompt when it is exactly at the limit', async () => {
  const ctx = testAgent();
  const exact = 'y'.repeat(120);

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: exact }] });
  await ctx.untilTurnEnd();

  expect(ctx.agent.turn.getLastPromptSummary()).toBe(exact);
});

it('joins the text parts of a prompt', async () => {
  const ctx = testAgent();

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({
    input: [
      { type: 'text', text: 'first part' },
      { type: 'text', text: 'second part' },
    ],
  });
  await ctx.untilTurnEnd();

  expect(ctx.agent.turn.getLastPromptSummary()).toBe('first part second part');
});

it('reports nothing for a prompt without text', async () => {
  const ctx = testAgent();

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({
    input: [{ type: 'image_url', imageUrl: { url: 'https://example.test/cat.png' } }],
  });
  await ctx.untilTurnEnd();

  expect(ctx.agent.turn.getLastPromptSummary()).toBeUndefined();
});

it('reports nothing for a prompt whose only text part is blank', async () => {
  const ctx = testAgent();

  ctx.mockNextResponse({ type: 'text', text: 'ok' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: '   \n  ' }] });
  await ctx.untilTurnEnd();

  expect(ctx.agent.turn.getLastPromptSummary()).toBeUndefined();
});
