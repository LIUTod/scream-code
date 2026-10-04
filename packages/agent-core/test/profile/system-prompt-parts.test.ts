import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SYSTEM_PROMPT_SPLIT_MARKER,
  splitSystemPrompt,
  systemPromptForRequest,
} from '../../src/profile/system-prompt-parts';

describe('splitSystemPrompt', () => {
  it('splits a rendered prompt at the marker', () => {
    const rendered = `static part${SYSTEM_PROMPT_SPLIT_MARKER}dynamic part`;
    const { staticPart, dynamicPart } = splitSystemPrompt(rendered);
    expect(staticPart).toBe('static part');
    expect(dynamicPart).toBe('dynamic part');
  });

  it('treats a prompt without the marker as fully static (hook-replaced prompts)', () => {
    const rendered = 'arbitrary replaced prompt';
    const { staticPart, dynamicPart } = splitSystemPrompt(rendered);
    expect(staticPart).toBe(rendered);
    expect(dynamicPart).toBe('');
  });

  it('falls back to static when the marker is not unique', () => {
    const rendered = `a${SYSTEM_PROMPT_SPLIT_MARKER}b${SYSTEM_PROMPT_SPLIT_MARKER}c`;
    const { staticPart, dynamicPart } = splitSystemPrompt(rendered);
    expect(staticPart).toBe(rendered);
    expect(dynamicPart).toBe('');
  });
});

describe('systemPromptForRequest', () => {
  it('returns [static, dynamic] when the split applies', () => {
    const rendered = `static part${SYSTEM_PROMPT_SPLIT_MARKER}dynamic part`;
    expect(systemPromptForRequest(rendered)).toEqual(['static part', 'dynamic part']);
  });

  it('returns the single rendered string when the marker is absent', () => {
    expect(systemPromptForRequest('plain prompt')).toBe('plain prompt');
  });
});

describe('system.md template', () => {
  it('carries the dynamic split marker exactly once, with its blank-line frame', () => {
    const templatePath = fileURLToPath(
      new URL('../../src/profile/default/system.md', import.meta.url),
    );
    const template = readFileSync(templatePath, 'utf8');
    expect(template.split('<!--scream:system-dynamic-->').length - 1).toBe(1);
    // The split only fires when the rendered text carries the exact
    // blank-line-framed marker; guard the frame here so a template edit
    // that silently breaks the split fails loudly instead of degrading.
    expect(template.split(SYSTEM_PROMPT_SPLIT_MARKER).length - 1).toBe(1);
  });
});
