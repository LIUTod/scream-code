import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineUserTool } from '../../../src/agent/tool/define-tool';

describe('defineUserTool', () => {
  it('derives an input-view JSON schema from a zod schema', () => {
    const tool = defineUserTool({
      name: 'example',
      description: 'An example tool',
      parameters: z.object({
        path: z.string(),
        count: z.number().default(1),
      }),
    });

    expect(tool.name).toBe('example');
    expect(tool.description).toBe('An example tool');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        count: { type: 'number', default: 1 },
      },
    });
  });

  it('keeps defaulted fields optional in the input view', () => {
    const tool = defineUserTool({
      name: 'example',
      description: 'An example tool',
      parameters: z.object({
        path: z.string(),
        count: z.number().default(1),
      }),
    });

    // The input view must NOT list a field with a chain-tail default as
    // required (see toInputJsonSchema rationale).
    const required = (tool.parameters as { required?: string[] }).required;
    expect(required).toBeDefined();
    expect(required).not.toContain('count');
    expect(required).toContain('path');
  });

  it('round-trips through the user-tool registration contract', () => {
    const tool = defineUserTool({
      name: 'example',
      description: 'An example tool',
      parameters: z.object({ path: z.string() }),
    });

    expect(Object.keys(tool).toSorted()).toEqual(
      ['description', 'name', 'parameters'].toSorted(),
    );
  });
});
