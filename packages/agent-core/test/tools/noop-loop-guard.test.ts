import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hashEditPayload,
  NOOP_HARD_LIMIT,
  recordFailedEdit,
  resetNoopLoop,
} from '../../src/tools/builtin/file/noop-loop-guard';

const PATH_A = '/workspace/a.ts';
const PATH_B = '/workspace/b.ts';

const PAYLOAD_1 = {
  path: PATH_A,
  old_string: 'foo',
  new_string: 'bar',
  replace_all: undefined,
  anchor: undefined,
};

const PAYLOAD_2 = {
  path: PATH_A,
  old_string: 'baz',
  new_string: 'qux',
  replace_all: undefined,
  anchor: undefined,
};

describe('noop-loop-guard', () => {
  beforeEach(() => {
    resetNoopLoop(PATH_A);
    resetNoopLoop(PATH_B);
  });

  afterEach(() => {
    resetNoopLoop(PATH_A);
    resetNoopLoop(PATH_B);
  });

  it('counts consecutive failures with the same payload on the same path', () => {
    resetNoopLoop(PATH_A);
    const hash = hashEditPayload(PAYLOAD_1);

    const r1 = recordFailedEdit(PATH_A, hash);
    expect(r1.count).toBe(1);
    expect(r1.escalate).toBe(false);

    const r2 = recordFailedEdit(PATH_A, hash);
    expect(r2.count).toBe(2);
    expect(r2.escalate).toBe(false);

    const r3 = recordFailedEdit(PATH_A, hash);
    expect(r3.count).toBe(3);
    expect(r3.escalate).toBe(true);
  });

  it('resets the counter when the payload changes on the same path', () => {
    resetNoopLoop(PATH_A);
    const h1 = hashEditPayload(PAYLOAD_1);
    const h2 = hashEditPayload(PAYLOAD_2);

    recordFailedEdit(PATH_A, h1);
    recordFailedEdit(PATH_A, h1);
    expect(recordFailedEdit(PATH_A, h1).count).toBe(3);

    const r = recordFailedEdit(PATH_A, h2);
    expect(r.count).toBe(1);
    expect(r.escalate).toBe(false);
  });

  it('tracks paths independently', () => {
    resetNoopLoop(PATH_A);
    resetNoopLoop(PATH_B);
    const hash = hashEditPayload(PAYLOAD_1);

    recordFailedEdit(PATH_A, hash);
    recordFailedEdit(PATH_A, hash);

    const rb = recordFailedEdit(PATH_B, hash);
    expect(rb.count).toBe(1);
    expect(rb.escalate).toBe(false);
  });

  it('resetNoopLoop clears the counter for a path', () => {
    resetNoopLoop(PATH_A);
    const hash = hashEditPayload(PAYLOAD_1);

    recordFailedEdit(PATH_A, hash);
    recordFailedEdit(PATH_A, hash);
    expect(recordFailedEdit(PATH_A, hash).count).toBe(3);

    resetNoopLoop(PATH_A);
    const r = recordFailedEdit(PATH_A, hash);
    expect(r.count).toBe(1);
    expect(r.escalate).toBe(false);
  });

  it('hashEditPayload is stable for identical input', () => {
    expect(hashEditPayload(PAYLOAD_1)).toBe(hashEditPayload(PAYLOAD_1));
  });

  it('hashEditPayload differs when any field differs', () => {
    const base = hashEditPayload(PAYLOAD_1);
    const modified = hashEditPayload({ ...PAYLOAD_1, old_string: 'different' });
    expect(modified).not.toBe(base);
  });

  it('escalates exactly at NOOP_HARD_LIMIT', () => {
    resetNoopLoop(PATH_A);
    const hash = hashEditPayload(PAYLOAD_1);
    for (let i = 1; i < NOOP_HARD_LIMIT; i++) {
      const r = recordFailedEdit(PATH_A, hash);
      expect(r.escalate).toBe(false);
    }
    const r = recordFailedEdit(PATH_A, hash);
    expect(r.escalate).toBe(true);
    expect(r.count).toBe(NOOP_HARD_LIMIT);
  });
});
