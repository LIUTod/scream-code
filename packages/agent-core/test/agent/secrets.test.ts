import { describe, expect, it } from 'vitest';

import type { Message } from '@scream-code/ltod';

import {
  compileSecretRegex,
  DEFAULT_SECRET_PATTERNS,
  deobfuscateAssistantContent,
  deobfuscateToolCalls,
  escapeRegExp,
  obfuscateMessages,
  SecretObfuscator,
} from '../../src/agent/secrets';
import type { SecretEntry } from '../../src/config/schema';

function plain(content: string): SecretEntry {
  return { type: 'plain', content, mode: 'obfuscate' };
}

function regex(content: string, flags?: string): SecretEntry {
  return { type: 'regex', content, mode: 'obfuscate', flags };
}

function replaceEntry(content: string, replacement?: string): SecretEntry {
  return { type: 'plain', content, mode: 'replace', replacement };
}

describe('SecretObfuscator', () => {
  it('round-trips a plain secret via obfuscate then deobfuscate', () => {
    const obf = new SecretObfuscator([plain('supersecretvalue')]);
    expect(obf.hasSecrets()).toBe(true);

    const obfuscated = obf.obfuscate('hello supersecretvalue world');
    expect(obfuscated).not.toContain('supersecretvalue');
    expect(obfuscated).toMatch(/#[A-Z2-9]{6}#/);

    const restored = obf.deobfuscate(obfuscated);
    expect(restored).toBe('hello supersecretvalue world');
  });

  it('skips plain secrets shorter than 8 characters', () => {
    const obf = new SecretObfuscator([plain('short')]);
    expect(obf.hasSecrets()).toBe(false);
    expect(obf.obfuscate('hello short world')).toBe('hello short world');
  });

  it('matches a regex secret and round-trips it', () => {
    const obf = new SecretObfuscator([regex('AKIA[0-9A-Z]{16}')]);
    const obfuscated = obf.obfuscate('key=AKIAIOSFODNN7EXAMPLE');
    expect(obfuscated).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(obf.deobfuscate(obfuscated)).toBe('key=AKIAIOSFODNN7EXAMPLE');
  });

  it('replace mode is one-way — original never returns', () => {
    const obf = new SecretObfuscator([replaceEntry('mysecretvalue', 'REDACTED')]);
    const obfuscated = obf.obfuscate('hello mysecretvalue world');
    expect(obfuscated).toBe('hello REDACTED world');
    expect(obf.deobfuscate(obfuscated)).toBe('hello REDACTED world');
  });

  it('replace mode without explicit replacement produces a stable [REDACTED-XXXX] marker', () => {
    const obf = new SecretObfuscator([replaceEntry('mysecretvalue')]);
    const a = obf.obfuscate('hello mysecretvalue world');
    const b = obf.obfuscate('hello mysecretvalue world');
    expect(a).toBe(b);
    expect(a).not.toContain('mysecretvalue');
    expect(a).toMatch(/\[REDACTED-[A-Z2-9]{4}\]/);
  });

  it('replace-mode markers are distinct from obfuscate-mode placeholders', () => {
    const obf = new SecretObfuscator([
      plain('mysecretvalue'),
      replaceEntry('othersecretvalue'),
    ]);
    const obfuscated = obf.obfuscate('mysecretvalue othersecretvalue');
    // obfuscate mode: #XXXXXX#; replace mode: [REDACTED-XXXX]
    expect(obfuscated).toMatch(/#[A-Z2-9]{6}#/);
    expect(obfuscated).toMatch(/\[REDACTED-[A-Z2-9]{4}\]/);
    // deobfuscate only restores obfuscate-mode placeholders
    const restored = obf.deobfuscate(obfuscated);
    expect(restored).toContain('mysecretvalue');
    expect(restored).not.toContain('othersecretvalue');
  });

  it('produces different placeholders for different secrets', () => {
    const obf = new SecretObfuscator([
      plain('alpha-secret-value'),
      plain('beta-secret-value'),
    ]);
    const obfuscated = obf.obfuscate('alpha-secret-value beta-secret-value');
    expect(obfuscated).not.toContain('alpha-secret-value');
    expect(obfuscated).not.toContain('beta-secret-value');
    const placeholders = obfuscated.match(/#[A-Z2-9]{6}#/g);
    expect(placeholders).not.toBeNull();
    expect(new Set(placeholders).size).toBe(2);
    expect(obf.deobfuscate(obfuscated)).toBe('alpha-secret-value beta-secret-value');
  });

  it('handles multiple occurrences of the same secret with the same placeholder', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const obfuscated = obf.obfuscate('a:mysecretvalue b:mysecretvalue');
    const placeholders = obfuscated.match(/#[A-Z2-9]{6}#/g);
    expect(placeholders).not.toBeNull();
    expect(new Set(placeholders).size).toBe(1);
    expect(obf.deobfuscate(obfuscated)).toBe('a:mysecretvalue b:mysecretvalue');
  });

  it('does nothing when no secrets are configured', () => {
    const obf = new SecretObfuscator([]);
    expect(obf.hasSecrets()).toBe(false);
    expect(obf.obfuscate('hello world')).toBe('hello world');
    expect(obf.deobfuscate('hello world')).toBe('hello world');
  });

  it('skips invalid regex entries silently', () => {
    const obf = new SecretObfuscator([
      { type: 'regex', content: '[invalid', mode: 'obfuscate' },
      plain('validsecretvalue'),
    ]);
    expect(obf.hasSecrets()).toBe(true);
    expect(obf.obfuscate('validsecretvalue')).not.toContain('validsecretvalue');
  });

  it('deobfuscateJsonString walks JSON values and restores placeholders', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const obfuscatedArg = obf.obfuscate('{"key":"mysecretvalue","nested":{"a":"mysecretvalue"}}');
    expect(obfuscatedArg).not.toContain('mysecretvalue');
    const restored = obf.deobfuscateJsonString(obfuscatedArg);
    expect(restored).not.toBeNull();
    expect(JSON.parse(restored!)).toEqual({
      key: 'mysecretvalue',
      nested: { a: 'mysecretvalue' },
    });
  });

  it('deobfuscateJsonString returns null for null input', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    expect(obf.deobfuscateJsonString(null)).toBeNull();
  });

  it('deobfuscateJsonString returns input unchanged when no placeholder is present', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    expect(obf.deobfuscateJsonString('{"k":"v"}')).toBe('{"k":"v"}');
  });

  it('deobfuscateJsonString falls back to raw deobfuscate when JSON parse fails', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const obfuscated = obf.obfuscate('mysecretvalue');
    const malformed = `not-json ${obfuscated}`;
    const restored = obf.deobfuscateJsonString(malformed);
    expect(restored).toBe('not-json mysecretvalue');
  });
});

describe('DEFAULT_SECRET_PATTERNS', () => {
  it('constructs an obfuscator that has secrets', () => {
    const obf = new SecretObfuscator(DEFAULT_SECRET_PATTERNS);
    expect(obf.hasSecrets()).toBe(true);
  });

  it('matches AWS access key id pattern', () => {
    const obf = new SecretObfuscator(DEFAULT_SECRET_PATTERNS);
    const text = 'aws_key=AKIAIOSFODNN7EXAMPLE';
    const obfuscated = obf.obfuscate(text);
    expect(obfuscated).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(obf.deobfuscate(obfuscated)).toBe(text);
  });

  it('matches GitHub personal access token', () => {
    const obf = new SecretObfuscator(DEFAULT_SECRET_PATTERNS);
    const token = 'ghp_' + 'a'.repeat(36);
    const text = `token: ${token}`;
    const obfuscated = obf.obfuscate(text);
    expect(obfuscated).not.toContain(token);
    expect(obf.deobfuscate(obfuscated)).toBe(text);
  });
});

describe('wire functions', () => {
  function userMessage(text: string): Message {
    return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
  }

  function assistantMessage(text: string, toolCallArgs?: string): Message {
    const toolCalls =
      toolCallArgs === undefined
        ? []
        : [
            {
              type: 'function' as const,
              id: 'call_1',
              name: 'Write',
              arguments: toolCallArgs,
            },
          ];
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls,
    };
  }

  it('obfuscateMessages rewrites secrets in all message roles including assistant', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const messages: Message[] = [
      userMessage('use mysecretvalue here'),
      assistantMessage('echo mysecretvalue'),
    ];
    const result = obfuscateMessages(obf, messages);
    expect((result[0]!.content[0] as { text: string }).text).not.toContain('mysecretvalue');
    // Assistant content is also obfuscated on outbound to catch the edge
    // case where the model emits a real secret it knew from training.
    expect((result[1]!.content[0] as { text: string }).text).not.toContain('mysecretvalue');
  });

  it('obfuscateMessages rewrites secrets in assistant toolCall arguments', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const messages: Message[] = [
      assistantMessage('writing file', JSON.stringify({ content: 'mysecretvalue' })),
    ];
    const result = obfuscateMessages(obf, messages);
    const args = result[0]!.toolCalls[0]!.arguments;
    expect(args).not.toBeNull();
    expect(args).not.toContain('mysecretvalue');
    // Deobfuscation restores the real secret for tool execution.
    expect(JSON.parse(obf.deobfuscateJsonString(args)!)).toEqual({ content: 'mysecretvalue' });
  });

  it('obfuscateMessages rewrites secrets in assistant think parts', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'planning with mysecretvalue' }],
        toolCalls: [],
      },
    ];
    const result = obfuscateMessages(obf, messages);
    expect((result[0]!.content[0] as { think: string }).think).not.toContain('mysecretvalue');
  });

  it('obfuscateMessages returns a shallow copy even when nothing changes', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const messages: Message[] = [userMessage('no secrets here')];
    const result = obfuscateMessages(obf, messages);
    expect(result).not.toBe(messages);
    expect(result[0]).toBe(messages[0]);
  });

  it('deobfuscateAssistantContent restores placeholders in text and think parts', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const placeholder = obf.obfuscate('mysecretvalue');
    const content = [
      { type: 'text' as const, text: `got ${placeholder}` },
      { type: 'think' as const, think: `thinking about ${placeholder}` },
    ];
    const result = deobfuscateAssistantContent(obf, content);
    expect((result[0] as { text: string }).text).toBe('got mysecretvalue');
    expect((result[1] as { think: string }).think).toBe('thinking about mysecretvalue');
  });

  it('deobfuscateAssistantContent returns a copy even when nothing changes', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const content = [{ type: 'text' as const, text: 'no placeholder' }];
    const result = deobfuscateAssistantContent(obf, content);
    expect(result).not.toBe(content);
    expect(result[0]).toBe(content[0]);
  });

  it('deobfuscateToolCalls restores placeholders inside tool call arguments JSON', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const placeholder = obf.obfuscate('mysecretvalue');
    const args = JSON.stringify({ path: '/a', content: placeholder });
    const calls = [
      { type: 'function' as const, id: 'call_1', name: 'Write', arguments: args },
    ];
    const result = deobfuscateToolCalls(obf, calls);
    expect(result[0]!.arguments).not.toBeNull();
    expect(JSON.parse(result[0]!.arguments!)).toEqual({
      path: '/a',
      content: 'mysecretvalue',
    });
  });

  it('deobfuscateToolCalls returns a copy when no calls changed', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const calls = [
      { type: 'function' as const, id: 'call_1', name: 'Write', arguments: '{"k":"v"}' },
    ];
    const result = deobfuscateToolCalls(obf, calls);
    expect(result).not.toBe(calls);
    expect(result[0]).toBe(calls[0]);
  });

  it('deobfuscateToolCalls handles null arguments without throwing', () => {
    const obf = new SecretObfuscator([plain('mysecretvalue')]);
    const calls = [
      { type: 'function' as const, id: 'call_1', name: 'Read', arguments: null },
    ];
    const result = deobfuscateToolCalls(obf, calls);
    expect(result[0]!.arguments).toBeNull();
  });
});

describe('regex helpers', () => {
  it('escapeRegExp escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c+d?')).toBe('a\\.b\\*c\\+d\\?');
  });

  it('compileSecretRegex forces global flag', () => {
    const re = compileSecretRegex('foo');
    expect(re.global).toBe(true);
  });

  it('compileSecretRegex preserves user-provided flags', () => {
    const re = compileSecretRegex('foo', 'i');
    expect(re.global).toBe(true);
    expect(re.ignoreCase).toBe(true);
  });

  it('compileSecretRegex parses /pattern/flags literal syntax', () => {
    const re = compileSecretRegex('/foo/gi');
    expect(re.source).toBe('foo');
    expect(re.global).toBe(true);
    expect(re.ignoreCase).toBe(true);
  });
});
