/**
 * Author-declared destructiveness (`annotations.destructiveHint`) → ask.
 *
 * The hint is unverified (MCP servers declare it themselves), so it is
 * consumed conservatively: it can force an approval where another policy
 * would auto-approve; it never grants one. auto/yolo approve earlier in the
 * chain and keep their pass-through semantics.
 */

import { describe, expect, it } from 'vitest';

import { makePermissionHarness, toolContext } from './fixtures/manager-harness';

const destructive = { destructiveHint: true } as const;

describe('destructive-hint-ask', () => {
  it('asks in manual mode even for a tool the catalog auto-approves', async () => {
    const { manager, requestApproval } = makePermissionHarness({
      handler: async () => ({ decision: 'rejected' }),
    });

    // TodoList is in DEFAULT_AUTO_APPROVE_TOOLS; the hint must outrank it.
    const result = await manager.beforeToolCall(
      toolContext('TodoList', { todos: [] }, destructive),
    );

    expect(result).toMatchObject({ block: true });
    // The approval prompt itself carries the hint reason.
    expect(JSON.stringify(requestApproval.mock.calls[0])).toContain('declares itself destructive');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('falls through unchanged when the hint is absent (catalog still approves)', async () => {
    const { manager, requestApproval } = makePermissionHarness();

    const result = await manager.beforeToolCall(toolContext('TodoList', { todos: [] }));

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not ask in auto mode — full pass-through stays intact', async () => {
    const { manager, requestApproval } = makePermissionHarness({ mode: 'auto' });

    const result = await manager.beforeToolCall(
      toolContext('TodoList', { todos: [] }, destructive),
    );

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not ask in yolo mode — tool pass-through stays intact', async () => {
    const { manager, requestApproval } = makePermissionHarness({ mode: 'yolo' });

    const result = await manager.beforeToolCall(
      toolContext('TodoList', { todos: [] }, destructive),
    );

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
