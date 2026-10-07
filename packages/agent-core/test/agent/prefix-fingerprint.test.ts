import type { Message } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import {
  messageFingerprint,
  serializeMessage,
  stablePrefixLength,
  toolDeclarationsFingerprint,
} from '../../src/agent/context/prefix-fingerprint';

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function toolResult(toolCallId: string, text: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolCallId,
  };
}

function tool(
  name: string,
  description = `${name} description`,
  parameters?: unknown,
): { name: string; description: string; parameters: unknown } {
  return { name, description, parameters: parameters ?? { type: 'object', properties: {} } };
}

describe('prefix-fingerprint', () => {
  describe('messageFingerprint', () => {
    it('produces equal fingerprints for byte-identical messages', () => {
      expect(messageFingerprint(user('hello'))).toBe(messageFingerprint(user('hello')));
    });

    it('produces different fingerprints for different content', () => {
      expect(messageFingerprint(user('hello'))).not.toBe(messageFingerprint(user('world')));
    });

    it('distinguishes messages by role', () => {
      expect(messageFingerprint(user('same text'))).not.toBe(
        messageFingerprint(assistant('same text')),
      );
    });

    it('distinguishes tool results by toolCallId', () => {
      expect(messageFingerprint(toolResult('call_a', 'output'))).not.toBe(
        messageFingerprint(toolResult('call_b', 'output')),
      );
    });

    it('includes think-part encrypted signatures (Anthropic reasoning blocks)', () => {
      const base = { role: 'assistant', content: [{ type: 'think', think: 'reasoning' }], toolCalls: [] } as Message;
      const withSig = {
        ...base,
        content: [{ type: 'think' as const, think: 'reasoning', encrypted: 'sig-abc' }],
      };
      expect(messageFingerprint(base)).not.toBe(messageFingerprint(withSig));
    });

    it('is deterministic (serializeMessage is stable across calls)', () => {
      const msg = user('stable');
      expect(serializeMessage(msg)).toBe(serializeMessage(msg));
    });
  });

  describe('stablePrefixLength', () => {
    it('returns the full previous length when only messages are appended', () => {
      const prev = [user('a'), assistant('b')].map(messageFingerprint);
      const current = [user('a'), assistant('b'), user('c')];
      expect(stablePrefixLength(prev, current)).toBe(2);
    });

    it('returns the full length when the prefix is unchanged and nothing appended', () => {
      const prev = [user('a'), assistant('b')].map(messageFingerprint);
      const current = [user('a'), assistant('b')];
      expect(stablePrefixLength(prev, current)).toBe(2);
    });

    it('breaks at the first mutated message (cache-break index)', () => {
      const prev = [user('a'), assistant('b'), user('c')].map(messageFingerprint);
      // Middle message mutated: assistant('b') -> assistant('CHANGED')
      const current = [user('a'), assistant('CHANGED'), user('c')];
      expect(stablePrefixLength(prev, current)).toBe(1);
    });

    it('reports 0 when the very first message changes (e.g. after compaction)', () => {
      const prev = [user('old'), assistant('old')].map(messageFingerprint);
      const current = [assistant('compaction summary'), user('recent')];
      expect(stablePrefixLength(prev, current)).toBe(0);
    });

    it('returns 0 against an empty previous baseline (first call)', () => {
      expect(stablePrefixLength([], [user('first')])).toBe(0);
    });

    it('handles micro-compaction-style truncation: a tool result shrinks to a marker', () => {
      const fullResult = toolResult('call_1', 'a very large tool output'.repeat(50));
      const markerResult = toolResult('call_1', '[Old tool result content cleared]');
      const prev = [user('q'), fullResult].map(messageFingerprint);
      // Same roles/ids but the tool result content mutated -> prefix breaks at index 1.
      const current = [user('q'), markerResult];
      expect(stablePrefixLength(prev, current)).toBe(1);
    });
  });

  describe('toolDeclarationsFingerprint', () => {
    it('is stable across calls and ignores key insertion order (schema included)', () => {
      const first = toolDeclarationsFingerprint([
        tool('Read', 'read a file', {
          type: 'object',
          properties: { path: { type: 'string' }, limit: { type: 'number' } },
          required: ['path'],
        }),
      ]);
      // Same values, keys inserted in another order at both levels — a schema
      // assembled by a different code path must not look like a change.
      const second = toolDeclarationsFingerprint([
        tool('Read', 'read a file', {
          required: ['path'],
          properties: { limit: { type: 'number' }, path: { type: 'string' } },
          type: 'object',
        }),
      ]);

      const build = () => toolDeclarationsFingerprint([tool('Read', 'read a file')]);
      expect(second).toBe(first);
      expect(build()).toBe(build());
    });

    it('changes when the offered tool set changes (MCP reconnect, /script, profile switch)', () => {
      const base = toolDeclarationsFingerprint([tool('Bash'), tool('Read')]);
      // A tool appears (MCP server reconnect) or disappears (/script off).
      expect(toolDeclarationsFingerprint([tool('Bash'), tool('Read'), tool('Write')])).not.toBe(base);
      expect(toolDeclarationsFingerprint([tool('Bash')])).not.toBe(base);
    });

    it('changes when a declaration is reordered (order is provider-visible)', () => {
      // The loop sends name-sorted tools, so a reorder is a real byte change,
      // not presentation: the hash must not normalize it away.
      expect(toolDeclarationsFingerprint([tool('Read'), tool('Bash')])).not.toBe(
        toolDeclarationsFingerprint([tool('Bash'), tool('Read')]),
      );
    });

    it('changes when a description or parameter schema changes (RunScript re-describes per step)', () => {
      const base = toolDeclarationsFingerprint([tool('RunScript', 'calls: Read, Bash')]);
      expect(toolDeclarationsFingerprint([tool('RunScript', 'calls: Read, Bash, Write')])).not.toBe(base);
      expect(
        toolDeclarationsFingerprint([
          tool('Read', 'read a file', { type: 'object', required: ['path'] }),
        ]),
      ).not.toBe(
        toolDeclarationsFingerprint([
          tool('Read', 'read a file', { type: 'object', required: ['path', 'limit'] }),
        ]),
      );
    });

    it('distinguishes an empty table from a populated one', () => {
      expect(toolDeclarationsFingerprint([])).not.toBe(
        toolDeclarationsFingerprint([tool('Read')]),
      );
    });
  });
});
