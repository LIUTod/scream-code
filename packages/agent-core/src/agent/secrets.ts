import { createHash } from 'node:crypto';

import type { ContentPart, Message, ToolCall } from '@scream-code/ltod';

import type { SecretEntry } from '../config/schema';

const PLACEHOLDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLACEHOLDER_LENGTH = 6;
const PLACEHOLDER_RE = /#[A-Z2-9]{6}#/g;

export function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileSecretRegex(pattern: string, flags?: string): RegExp {
  let resolvedPattern = pattern;
  let resolvedFlags = flags ?? '';

  const literalMatch = /^\/((?:[^\\/]|\\.)*)\/([ gimsuy]*)$/.exec(pattern);
  if (literalMatch) {
    if (literalMatch[1] !== undefined) resolvedPattern = literalMatch[1];
    if (literalMatch[2] !== undefined) {
      const combined = new Set(Array.from(resolvedFlags).concat(Array.from(literalMatch[2])));
      resolvedFlags = Array.from(combined).join('');
    }
  }

  if (!resolvedFlags.includes('g')) resolvedFlags += 'g';
  return new RegExp(resolvedPattern, resolvedFlags);
}

function replaceAll(text: string, search: string, replacement: string): string {
  if (search.length === 0) return text;
  return text.split(search).join(replacement);
}

function buildPlaceholder(secret: string, salt: string): string {
  const hash = createHash('sha256').update(`${salt}:${secret}`).digest();
  let s = '#';
  for (let i = 0; i < PLACEHOLDER_LENGTH; i++) {
    const byte = hash[i] ?? 0;
    s += PLACEHOLDER_ALPHABET[byte % PLACEHOLDER_ALPHABET.length];
  }
  return s + '#';
}

function buildReplaceMarker(secret: string, salt: string): string {
  const hash = createHash('sha256').update(`replace:${salt}:${secret}`).digest();
  let s = '[REDACTED-';
  for (let i = 0; i < 4; i++) {
    const byte = hash[i] ?? 0;
    s += PLACEHOLDER_ALPHABET[byte % PLACEHOLDER_ALPHABET.length];
  }
  return s + ']';
}

interface RegexEntry {
  regex: RegExp;
  mode: 'obfuscate' | 'replace';
  replacement?: string;
  salt: string;
}

export class SecretObfuscator {
  private readonly plainObfuscate = new Map<string, string>();
  private readonly plainReplace = new Map<string, string>();
  private readonly regexEntries: RegexEntry[] = [];
  private readonly placeholderToSecret = new Map<string, string>();
  private readonly secretToPlaceholder = new Map<string, string>();
  private readonly hasAny: boolean;

  constructor(entries: readonly SecretEntry[]) {
    let hasReal = false;
    for (const entry of entries) {
      const mode = entry.mode ?? 'obfuscate';
      if (entry.type === 'plain') {
        if (mode === 'obfuscate') {
          if (entry.content.length < 8) continue;
          const placeholder = buildPlaceholder(entry.content, 'plain');
          this.plainObfuscate.set(entry.content, placeholder);
          this.placeholderToSecret.set(placeholder, entry.content);
          this.secretToPlaceholder.set(entry.content, placeholder);
          hasReal = true;
        } else {
          const replacement = entry.replacement ?? buildReplaceMarker(entry.content, 'plain');
          this.plainReplace.set(entry.content, replacement);
          hasReal = true;
        }
      } else {
        try {
          const regex = compileSecretRegex(entry.content, entry.flags);
          this.regexEntries.push({
            regex,
            mode,
            replacement: entry.replacement,
            salt: entry.content,
          });
          hasReal = true;
        } catch {
          // Invalid regex — skip silently.
        }
      }
    }
    this.hasAny = hasReal;
  }

  private placeholderFor(secret: string, salt: string): string {
    const existing = this.secretToPlaceholder.get(secret);
    if (existing !== undefined) return existing;
    let placeholder = buildPlaceholder(secret, salt);
    if (this.placeholderToSecret.has(placeholder)) {
      placeholder = buildPlaceholder(secret, `${salt}:alt`);
    }
    this.secretToPlaceholder.set(secret, placeholder);
    this.placeholderToSecret.set(placeholder, secret);
    return placeholder;
  }

  hasSecrets(): boolean {
    return this.hasAny;
  }

  obfuscate(text: string): string {
    if (!this.hasAny) return text;
    let result = text;

    const replaceSorted = [...this.plainReplace.entries()].toSorted(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [secret, replacement] of replaceSorted) {
      result = replaceAll(result, secret, replacement);
    }

    const obfuscateSorted = [...this.plainObfuscate.entries()].toSorted(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [secret, placeholder] of obfuscateSorted) {
      result = replaceAll(result, secret, placeholder);
    }

    for (const entry of this.regexEntries) {
      entry.regex.lastIndex = 0;
      const matches = new Set<string>();
      for (;;) {
        const match = entry.regex.exec(result);
        if (match === null) break;
        if (match[0].length === 0) {
          entry.regex.lastIndex++;
          continue;
        }
        matches.add(match[0]);
      }

      for (const matchValue of matches) {
        if (entry.mode === 'replace') {
          const replacement =
            entry.replacement ?? buildReplaceMarker(matchValue, entry.salt);
          result = replaceAll(result, matchValue, replacement);
        } else {
          if (matchValue.length < 8) continue;
          const placeholder = this.placeholderFor(matchValue, entry.salt);
          result = replaceAll(result, matchValue, placeholder);
        }
      }
    }

    return result;
  }

  deobfuscate(text: string): string {
    if (!this.hasAny || !text.includes('#')) return text;
    return text.replaceAll(PLACEHOLDER_RE, (match) => this.placeholderToSecret.get(match) ?? match);
  }

  deobfuscateJsonString(jsonStr: string | null): string | null {
    if (jsonStr === null) return null;
    if (!this.hasAny || !jsonStr.includes('#')) return jsonStr;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return this.deobfuscate(jsonStr);
    }
    const walked = mapJsonStrings(parsed, (s) => this.deobfuscate(s));
    return JSON.stringify(walked);
  }

  obfuscateJsonString(jsonStr: string | null): string | null {
    if (jsonStr === null) return null;
    if (!this.hasAny) return jsonStr;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return this.obfuscate(jsonStr);
    }
    const walked = mapJsonStrings(parsed, (s) => this.obfuscate(s));
    return JSON.stringify(walked);
  }
}

function mapJsonStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = mapJsonStrings(item, fn);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      const next = mapJsonStrings(item, fn);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

export function obfuscateMessages(
  obf: SecretObfuscator,
  messages: readonly Message[],
): Message[] {
  if (!obf.hasSecrets()) return [...messages];
  let changed = false;
  const result = messages.map((message): Message => {
    let localChanged = false;

    // Obfuscate text and think parts in all message roles. Assistant
    // content is normally persisted as placeholder already, but this
    // catches the edge case where the model emits a real secret it
    // knew from training (not from obfuscated context). Think parts
    // carry the same risk and are persisted via onThinkPart.
    const content = message.content.map((part): ContentPart => {
      if (part.type === 'text') {
        const text = obf.obfuscate(part.text);
        if (text === part.text) return part;
        localChanged = true;
        return { ...part, text };
      }
      if (part.type === 'think') {
        const think = obf.obfuscate(part.think);
        if (think === part.think) return part;
        localChanged = true;
        return { ...part, think };
      }
      return part;
    });

    // Obfuscate assistant toolCall arguments. These are persisted with
    // real secrets (response.toolCalls is deobfuscated for tool
    // execution, and the tool.call event carries deobfuscated args into
    // the persisted assistant message). Without this outbound pass, the
    // real secret would leak to the provider on the next turn.
    let toolCalls = message.toolCalls;
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      let tcChanged = false;
      toolCalls = message.toolCalls.map((call): ToolCall => {
        if (call.arguments === null) return call;
        const obfuscated = obf.obfuscateJsonString(call.arguments);
        if (obfuscated === call.arguments) return call;
        tcChanged = true;
        return { ...call, arguments: obfuscated };
      });
      if (tcChanged) localChanged = true;
    }

    if (!localChanged) return message;
    changed = true;
    return { ...message, content, toolCalls };
  });
  return changed ? result : [...messages];
}

export function deobfuscateAssistantContent(
  obf: SecretObfuscator,
  content: readonly ContentPart[],
): ContentPart[] {
  if (!obf.hasSecrets()) return [...content];
  let changed = false;
  const result = content.map((part): ContentPart => {
    if (part.type === 'text') {
      const text = obf.deobfuscate(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    }
    if (part.type === 'think') {
      const think = obf.deobfuscate(part.think);
      if (think === part.think) return part;
      changed = true;
      return { ...part, think };
    }
    return part;
  });
  return changed ? result : [...content];
}

export function deobfuscateToolCalls(
  obf: SecretObfuscator,
  toolCalls: readonly ToolCall[],
): ToolCall[] {
  if (!obf.hasSecrets()) return [...toolCalls];
  let changed = false;
  const result = toolCalls.map((call): ToolCall => {
    const args = obf.deobfuscateJsonString(call.arguments);
    if (args === call.arguments) return call;
    changed = true;
    return { ...call, arguments: args };
  });
  return changed ? result : [...toolCalls];
}

export const DEFAULT_SECRET_PATTERNS: readonly SecretEntry[] = [
  { type: 'regex', content: 'AKIA[0-9A-Z]{16}', mode: 'obfuscate' },
  { type: 'regex', content: 'ghp_[A-Za-z0-9]{36}', mode: 'obfuscate' },
  { type: 'regex', content: 'gho_[A-Za-z0-9]{36}', mode: 'obfuscate' },
  { type: 'regex', content: 'ghs_[A-Za-z0-9]{36}', mode: 'obfuscate' },
  { type: 'regex', content: 'sk-proj-[A-Za-z0-9\\-_]{20,}', mode: 'obfuscate' },
  { type: 'regex', content: 'sk-[A-Za-z0-9]{48}', mode: 'obfuscate' },
  { type: 'regex', content: 'sk-ant-[A-Za-z0-9\\-_]{20,}', mode: 'obfuscate' },
  {
    type: 'regex',
    content: '(api[_-]?key|apikey|token|secret)["\'\\s:=]+["\']?([A-Za-z0-9\\-_]{20,})',
    mode: 'obfuscate',
  },
];
