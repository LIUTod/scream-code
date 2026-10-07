/**
 * Byte-stability regression matrix for the provider-facing request shape.
 *
 * Providers cache prompt prefixes by exact byte match, so every LLM-bound
 * build must be deterministic for a given agent state and must change only by
 * appending at the tail. These tests pin that contract:
 *
 * - T1: repeated `messagesForLLM()` builds of the same state serialise to the
 *   same bytes;
 * - T2: appending messages preserves the previous prefix, while an edited
 *   history message breaks it at the edited index and is recorded on the wire
 *   as `context.prefix_break` (and only the break path writes a record);
 * - T3: the request tool table serialises identically across builds (key order
 *   included);
 * - T4: the system prompt's static block is byte-stable per role and free of
 *   volatile content (clock, ids) — which must stay in the dynamic block;
 * - T5: a sub-profile agent (subagent-shaped prompt, prefix independent from
 *   its parent's) keeps the same T1/T2 invariants across its own multi-turn
 *   history;
 * - T6: the tool declaration table is part of the observed prefix — a rebuilt
 *   table (MCP reconnect, /script toggle, profile switch) breaks it at message
 *   index 0 and is wire-recorded even though every message byte is unchanged.
 */
import { describe, expect, it } from 'vitest';

import {
  messageFingerprint,
  stablePrefixLength,
} from '../../src/agent/context/prefix-fingerprint';
import type { AgentRecord } from '../../src/agent/records';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import {
  DEFAULT_AGENT_PROFILES,
  splitSystemPrompt,
  systemPromptForRequest,
  type SystemPromptContext,
} from '../../src/profile';
import { TEST_OS_ENV } from '../fixtures/test-jian';
import { createFakeJian } from '../tools/fixtures/fake-jian';

import { testAgent } from './harness/agent';

type PrefixBreakRecord = Extract<AgentRecord, { type: 'context.prefix_break' }>;

const TEST_PROVIDER = {
  type: 'scream',
  apiKey: 'test-key',
  model: 'scream-code',
} as const;
const TEST_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const ISO_UTC_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function collectRecords(): {
  readonly records: AgentRecord[];
  readonly onEvent: (event: AgentRecord) => undefined;
} {
  const records: AgentRecord[] = [];
  return {
    records,
    onEvent: (event) => {
      records.push(event);
      return undefined;
    },
  };
}

function prefixBreaks(records: readonly AgentRecord[]): PrefixBreakRecord[] {
  return records.filter(
    (record): record is PrefixBreakRecord => record.type === 'context.prefix_break',
  );
}

function promptContext(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    osEnv: TEST_OS_ENV,
    cwd: '/workspace/project',
    now: '2026-05-09T00:00:00.000Z',
    cwdListing: 'src/\ntest/',
    agentsMd: 'Follow the house rules.',
    skills: '',
    ...overrides,
  };
}

describe('prefix stability matrix', () => {
  it('T1: two builds of the same state serialise to byte-identical LLM messages', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendExchange(1, 'first question', 'first answer', 20);
    ctx.appendExchange(2, 'second question', 'second answer', 40);

    const first = ctx.agent.context.messagesForLLM();
    const second = ctx.agent.context.messagesForLLM();

    // Non-vacuity: byte-identity between two empty lists would prove nothing.
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(first.length);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.map(messageFingerprint)).toEqual(first.map(messageFingerprint));
  });

  it('T2: appends keep the prefix intact; an edited message breaks it and is wire-recorded', () => {
    const { records, onEvent } = collectRecords();
    const ctx = testAgent({ onEvent });
    ctx.configure();
    ctx.appendExchange(1, 'first question', 'first answer', 20);

    const batch1 = ctx.agent.context.messagesForLLM();
    expect(batch1).toHaveLength(2);
    const baseline = batch1.map(messageFingerprint);

    // Append N=2 messages: the previous prefix must survive untouched...
    ctx.appendExchange(2, 'second question', 'second answer', 40);
    const batch2 = ctx.agent.context.messagesForLLM();
    expect(batch2).toHaveLength(4);
    expect(stablePrefixLength(baseline, batch2)).toBe(batch1.length);
    // ...and the append-only path must not emit prefix-break records.
    expect(prefixBreaks(records)).toHaveLength(0);

    // Break it deliberately: edit the second user turn (projection index 2).
    ctx.agent.context.applyMessageEdit('m2', [{ type: 'text', text: 'edited second question' }]);
    const batch3 = ctx.agent.context.messagesForLLM();
    expect(stablePrefixLength(batch2.map(messageFingerprint), batch3)).toBe(2);

    const breaks = prefixBreaks(records);
    expect(breaks).toHaveLength(1);
    const brk = breaks[0]!;
    expect(brk.breakIndex).toBe(2);
    expect(brk.prevMessageCount).toBe(batch2.length);
    expect(brk.currentMessageCount).toBe(batch3.length);
    expect(brk.appendedSinceLast).toBe(0);
    expect(typeof brk.time).toBe('number');

    // A no-op rebuild after the break must NOT re-record it: one logical break
    // writes exactly one wire record (a "log on every build" regression would
    // surface here as a second entry).
    ctx.agent.context.messagesForLLM();
    expect(prefixBreaks(records)).toHaveLength(1);

    // Shrink form: `undo` rewinds the trailing exchange, so the current list
    // is SHORTER than the previous one — the full-compaction / undo cache-break
    // shape. The two counts differ, which is what makes the count and
    // `appendedSinceLast` assertions interchangeable-proof.
    ctx.agent.context.undo(1);
    const batch4 = ctx.agent.context.messagesForLLM();
    expect(batch4).toHaveLength(2);
    expect(stablePrefixLength(batch3.map(messageFingerprint), batch4)).toBe(2);

    const afterShrink = prefixBreaks(records);
    expect(afterShrink).toHaveLength(2);
    const shrinkBreak = afterShrink[1]!;
    expect(shrinkBreak.breakIndex).toBe(2);
    // Hand-computed constants from the constructed lists (4 -> 2), asserted
    // separately so a swapped or cross-hardcoded field pair cannot satisfy both.
    expect(shrinkBreak.prevMessageCount).toBe(4);
    expect(shrinkBreak.currentMessageCount).toBe(2);
    expect(shrinkBreak.prevMessageCount).not.toBe(shrinkBreak.currentMessageCount);
    // Negative append: |difference| hand-computed (-2), and the sign follows
    // the definition current - previous. A constant 0 or a sign flip cannot
    // satisfy both assertions.
    expect(shrinkBreak.appendedSinceLast).toBe(-2);
    expect(shrinkBreak.appendedSinceLast).toBe(
      shrinkBreak.currentMessageCount - shrinkBreak.prevMessageCount,
    );
    expect(typeof shrinkBreak.time).toBe('number');

    // The shrink break is likewise recorded once, not once per rebuild.
    ctx.agent.context.messagesForLLM();
    expect(prefixBreaks(records)).toHaveLength(2);
  });

  it('T3: the request tool table serialises identically across builds (key order locked)', () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash', 'Read', 'Write'] });

    const buildToolTable = () =>
      ctx.agent.tools.loopTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    const first = buildToolTable();
    // loopTools is name-sorted (the same order the main loop and compaction
    // send), so the table order is part of the cache prefix contract.
    expect(first.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Write']);
    expect(JSON.stringify(buildToolTable())).toBe(JSON.stringify(first));
  });

  it('T3b: full compaction reuses the main loop split prompt and tool table', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: TEST_PROVIDER, modelCapabilities: TEST_MODEL_CAPABILITIES });
    ctx.agent.useProfile(DEFAULT_AGENT_PROFILES['agent']!);
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);

    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('context.apply_compaction', () => {
        resolve();
      });
    });
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;

    const call = ctx.llmCalls.at(-1)!;
    // The compaction request must be the same request form the main loop
    // sends: the split [static, dynamic] system blocks and the name-sorted
    // tool table — otherwise the shared provider prefix cache cannot hit.
    expect(call.systemPrompt).toEqual(ctx.agent.getRuntimeSystemPromptBlocks());
    expect(call.systemPrompt).toHaveLength(2);
    expect(call.tools.map((tool) => tool.name)).toEqual(
      ctx.agent.tools.loopTools.map((tool) => tool.name),
    );
  });

  it('T4: static system-prompt block is byte-stable per role; volatile content stays dynamic', () => {
    for (const [name, profile] of Object.entries(DEFAULT_AGENT_PROFILES)) {
      const rendered = profile.systemPrompt(promptContext());
      // Same role, same context, rendered twice: byte-identical.
      expect(profile.systemPrompt(promptContext()), `${name} render must be deterministic`).toBe(
        rendered,
      );

      const { staticPart, dynamicPart } = splitSystemPrompt(rendered);
      expect(staticPart.length, `${name} static block`).toBeGreaterThan(0);
      expect(dynamicPart.length, `${name} dynamic block`).toBeGreaterThan(0);
      // Static bytes are the cache-sensitive region: no clock, no ids.
      expect(staticPart, `${name} static block carries a timestamp`).not.toMatch(ISO_UTC_RE);
      expect(staticPart, `${name} static block carries a UUID`).not.toMatch(UUID_RE);

      const later = splitSystemPrompt(
        profile.systemPrompt(promptContext({ now: '2027-12-31T23:59:59.000Z' })),
      );
      // Re-rendering at a different time must leave the static block
      // byte-identical...
      expect(later.staticPart, `${name} static block is time-sensitive`).toBe(staticPart);
      // ...while the clock moves only inside the dynamic block (locked in).
      expect(later.dynamicPart, `${name} dynamic block should carry the clock`).not.toBe(dynamicPart);

      // Every request path (main loop, compaction) shares this split form.
      expect(systemPromptForRequest(rendered)).toEqual([staticPart, dynamicPart]);
    }
  });

  it('T6: a tool-declaration change breaks the prefix and is wire-recorded', () => {
    const { records, onEvent } = collectRecords();
    const ctx = testAgent({ onEvent });
    ctx.configure({ tools: ['Read', 'Write'] });
    ctx.appendExchange(1, 'first question', 'first answer', 20);
    ctx.appendExchange(2, 'second question', 'second answer', 40);

    const batch1 = ctx.agent.context.messagesForLLM();
    expect(batch1).toHaveLength(4);
    // First build of the session: no baseline, no break to report.
    expect(prefixBreaks(records)).toHaveLength(0);

    // Steady state with a fixed tool table: appends stay off the wire. The tool
    // fingerprint must not turn an append-only turn into a break.
    ctx.appendExchange(3, 'third question', 'third answer', 60);
    const batch2 = ctx.agent.context.messagesForLLM();
    expect(stablePrefixLength(batch1.map(messageFingerprint), batch2)).toBe(batch1.length);
    expect(prefixBreaks(records)).toHaveLength(0);

    // The offered table changes (`/script` toggle, MCP server reconnect): the
    // message bytes are identical to the previous build, so the message-level
    // comparison calls this a full cache hit — the provider prefix is dead.
    ctx.agent.tools.setActiveTools(['Read', 'Write', 'Bash']);
    const batch3 = ctx.agent.context.messagesForLLM();
    expect(JSON.stringify(batch3)).toBe(JSON.stringify(batch2));
    expect(stablePrefixLength(batch2.map(messageFingerprint), batch3)).toBe(batch2.length);

    const breaks = prefixBreaks(records);
    expect(breaks).toHaveLength(1);
    const brk = breaks[0]!;
    expect(brk.breakIndex).toBe(0);
    expect(brk.prevMessageCount).toBe(batch2.length);
    expect(brk.currentMessageCount).toBe(batch3.length);
    expect(brk.appendedSinceLast).toBe(0);
    expect(typeof brk.time).toBe('number');

    // One logical table change -> exactly one record: a rebuild that sends the
    // already-changed table must not re-report it.
    ctx.agent.context.messagesForLLM();
    expect(prefixBreaks(records)).toHaveLength(1);

    // Restoring the table is a change too — the comparison is between table
    // states, not "has it ever changed".
    ctx.agent.tools.setActiveTools(['Read', 'Write']);
    ctx.agent.context.messagesForLLM();
    expect(prefixBreaks(records)).toHaveLength(2);

    // Profile switch (the subagent path): the child's tool list replaces the
    // active set, so the declaration table moves again.
    ctx.agent.useProfile(DEFAULT_AGENT_PROFILES['explore']!);
    ctx.agent.context.messagesForLLM();
    expect(prefixBreaks(records)).toHaveLength(3);
    expect(prefixBreaks(records)[2]!.breakIndex).toBe(0);

    // Explicit-table form — the shape the turn loop uses. The observer follows
    // the table it is handed, not the live set: a mid-turn `setActiveTools`
    // that the turn's frozen filter holds back for the next turn must not
    // register, because the request (and therefore the cache prefix) did not
    // change. Passing the live table afterwards reports the real move.
    const frozenTable = ctx.agent.tools.loopToolsFor(ctx.agent.tools.snapshotEnabledTools());
    ctx.agent.context.messagesForLLM(frozenTable);
    expect(prefixBreaks(records)).toHaveLength(3);
    ctx.agent.tools.setActiveTools(['Bash']);
    ctx.agent.context.messagesForLLM(frozenTable);
    expect(prefixBreaks(records)).toHaveLength(3);
    ctx.agent.context.messagesForLLM(ctx.agent.tools.loopTools);
    expect(prefixBreaks(records)).toHaveLength(4);
  });

  it('T5: a sub-profile agent keeps its own append-only prefix across turns', async () => {
    // A dedicated persistence captures EVERY appended record (the harness
    // suppresses its public wire events during `dispatch`, so an onEvent
    // collector would miss the loop-event records that rebuild history).
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ type: 'sub', persistence });
    ctx.configure();
    const subProfile = DEFAULT_AGENT_PROFILES['explore']!;
    ctx.agent.useProfile(subProfile);

    // Same-role renders are byte-identical, and the sub profile's static block
    // is a distinct string from the main agent's: the subagent prefix diverges
    // at token 0 (no verbatim fork of the parent prefix).
    const subStatic = splitSystemPrompt(subProfile.systemPrompt(promptContext())).staticPart;
    const mainStatic = splitSystemPrompt(
      DEFAULT_AGENT_PROFILES['agent']!.systemPrompt(promptContext()),
    ).staticPart;
    expect(splitSystemPrompt(subProfile.systemPrompt(promptContext())).staticPart).toBe(subStatic);
    expect(subStatic).not.toBe(mainStatic);

    // T1 on the sub agent: idempotent rebuild.
    ctx.appendExchange(1, 'sub turn 1', 'sub answer 1', 10);
    const first = ctx.agent.context.messagesForLLM();
    expect(JSON.stringify(ctx.agent.context.messagesForLLM())).toBe(JSON.stringify(first));

    // T2 on the sub agent: multi-turn appends preserve the established prefix.
    ctx.appendExchange(2, 'sub turn 2', 'sub answer 2', 20);
    ctx.appendExchange(3, 'sub turn 3', 'sub answer 3', 30);
    const later = ctx.agent.context.messagesForLLM();
    expect(later).toHaveLength(6);
    expect(stablePrefixLength(first.map(messageFingerprint), later)).toBe(first.length);
    expect(prefixBreaks(persistence.records)).toHaveLength(0);

    // Resume replay: a fresh agent rebuilt from the wire reproduces the same
    // message bytes, and one more append round on the resumed agent still
    // preserves the prefix — the sub agent is append-only across a resume
    // boundary too.
    const resumedCtx = testAgent({
      jian: createFakeJian(),
      persistence: new InMemoryAgentRecordPersistence(
        persistence.records.map((record) => structuredClone(record)),
      ),
    });
    await resumedCtx.agent.resume();

    const replayed = resumedCtx.agent.context.messagesForLLM();
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(later));

    const resumedBaseline = replayed.map(messageFingerprint);
    resumedCtx.appendExchange(4, 'resumed turn 4', 'resumed answer 4', 40);
    const resumedLater = resumedCtx.agent.context.messagesForLLM();
    expect(stablePrefixLength(resumedBaseline, resumedLater)).toBe(replayed.length);
  });
});
