import { describe, expect, it } from 'vitest';

import { HookEngine } from '#/session/hooks/engine';
import type { HookDef } from '#/session/hooks/types';

const HOOK_A: HookDef = { event: 'PreToolUse', command: 'echo a' };
const HOOK_B: HookDef = { event: 'PostToolUse', command: 'echo b' };

describe('HookEngine dynamic registration', () => {
  it('registers a hook and reflects it in the summary', () => {
    const engine = new HookEngine();
    expect(engine.summary['PreToolUse']).toBeUndefined();

    engine.register(HOOK_A);
    expect(engine.summary['PreToolUse']).toBe(1);

    engine.register(HOOK_B);
    expect(engine.summary['PostToolUse']).toBe(1);
  });

  it('unregisters a hook via the returned function', () => {
    const engine = new HookEngine();
    const unregister = engine.register(HOOK_A);

    unregister();
    expect(engine.summary['PreToolUse']).toBeUndefined();
  });

  it('registerAll registers every hook and the batch unregister removes all', () => {
    const engine = new HookEngine();
    const unregisterAll = engine.registerAll([HOOK_A, HOOK_B, HOOK_A]);

    expect(engine.summary['PreToolUse']).toBe(2);
    expect(engine.summary['PostToolUse']).toBe(1);

    unregisterAll();
    expect(engine.summary).toEqual({});
  });

  it('coexists with constructor-injected hooks', () => {
    const engine = new HookEngine([HOOK_A]);
    expect(engine.summary['PreToolUse']).toBe(1);

    const unregister = engine.register(HOOK_A);
    expect(engine.summary['PreToolUse']).toBe(2);

    unregister();
    // Constructor hook remains; only the dynamically registered one is removed.
    expect(engine.summary['PreToolUse']).toBe(1);
  });

  it('removing a non-registered hook is a no-op', () => {
    const engine = new HookEngine();
    engine.register(HOOK_A);

    const fake: HookDef = { event: 'PreToolUse', command: 'echo missing' };
    // Reach the private unregister via a register+unregister cycle on a fresh hook.
    const unregister = engine.register(fake);
    unregister();
    unregister(); // second call is safe

    expect(engine.summary['PreToolUse']).toBe(1); // HOOK_A still present
  });
});
