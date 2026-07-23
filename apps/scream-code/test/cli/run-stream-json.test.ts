import { describe, expect, it } from 'vitest';

import { buildStreamJsonRuntimePrompt } from '../../src/cli/run-stream-json';

describe('stream-json runtime system prompt', () => {
  it('keeps the default profile when only append prompts are supplied', () => {
    const prompt = buildStreamJsonRuntimePrompt({
      appendSystemPrompt: 'inline instructions',
      appendSystemPromptFileContent: 'file instructions',
    });

    expect(prompt.replace).toBeUndefined();
    expect(prompt.append).toContain('cc-connect send --image');
    expect(prompt.append).toContain('cc-connect send --file');
    expect(prompt.append.indexOf('inline instructions')).toBeLessThan(
      prompt.append.indexOf('file instructions'),
    );
  });

  it('normalizes a replacement prompt and appends delivery instructions after it', () => {
    const prompt = buildStreamJsonRuntimePrompt({
      systemPrompt: '  replacement prompt  ',
      appendSystemPrompt: '  extra instructions  ',
    });

    expect(prompt.replace).toBe('replacement prompt');
    expect(prompt.append).toMatch(/^【重要】/);
    expect(prompt.append).toContain('\n\nextra instructions');
  });

  it('ignores empty optional prompt parts without changing the stable send hint', () => {
    const prompt = buildStreamJsonRuntimePrompt({
      systemPrompt: '   ',
      appendSystemPrompt: '',
      appendSystemPromptFileContent: '  ',
    });

    expect(prompt.replace).toBeUndefined();
    expect(prompt.append).toContain('cc-connect send --image');
    expect(prompt.append).not.toContain('\n\n\n');
  });
});
