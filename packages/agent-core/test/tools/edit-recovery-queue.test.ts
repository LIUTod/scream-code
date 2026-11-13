import { describe, expect, it } from 'vitest';

import {
  EDIT_RECOVERY_INSTRUCTION,
  EditRecoveryQueue,
  type EditRecoverySignature,
} from '../../src/tools/support/edit-recovery-queue';

function signature(line: number, message = `error ${String(line)}`): EditRecoverySignature {
  return { signature: `1:${message}:${String(line - 1)}`, line, message };
}

function reminder(
  path: string,
  signatures: readonly EditRecoverySignature[],
): Parameters<EditRecoveryQueue['enqueue']>[0] {
  return {
    path,
    displayPath: path.replace('/w/', ''),
    signatures,
    instruction: EDIT_RECOVERY_INSTRUCTION,
  };
}

describe('EditRecoveryQueue', () => {
  it('collapses identical path + signature-set enqueues into one item', () => {
    const queue = new EditRecoveryQueue();
    queue.enqueue(reminder('/w/a.ts', [signature(1), signature(2)]));
    // Same set, different order: the canonical key sorts signatures.
    queue.enqueue(reminder('/w/a.ts', [signature(2), signature(1)]));

    expect(queue.size).toBe(1);
    expect(queue.drain()).toHaveLength(1);
  });

  it('keeps distinct signature sets as separate items and ignores empty ones', () => {
    const queue = new EditRecoveryQueue();
    queue.enqueue(reminder('/w/a.ts', [signature(1)]));
    queue.enqueue(reminder('/w/a.ts', [signature(2)]));
    queue.enqueue(reminder('/w/b.ts', [signature(1)]));
    queue.enqueue(reminder('/w/a.ts', []));

    expect(queue.size).toBe(3);
  });

  it('drains without clearing', () => {
    const queue = new EditRecoveryQueue();
    queue.enqueue(reminder('/w/a.ts', [signature(1)]));

    expect(queue.drain()).toHaveLength(1);
    expect(queue.drain()).toHaveLength(1);
    expect(queue.size).toBe(1);
  });

  it('clears a path only once every one of its signatures is gone', () => {
    const queue = new EditRecoveryQueue();
    queue.enqueue(reminder('/w/a.ts', [signature(1), signature(2)]));
    queue.enqueue(reminder('/w/b.ts', [signature(1)]));

    // One signature still reported: the item stays pending.
    queue.clearIfResolved('/w/a.ts', new Set([signature(2).signature]));
    expect(queue.size).toBe(2);

    queue.clearIfResolved('/w/a.ts', new Set());
    expect(queue.size).toBe(1);
    expect(queue.drain()[0]?.path).toBe('/w/b.ts');
  });
});
