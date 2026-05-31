import { describe, expect, it } from 'vitest';

import { FrontmatterError, parseFrontmatter } from '../../src/skill/parser';

describe('parseFrontmatter', () => {
  it('parses a leading YAML block and discards it from body', () => {
    const text = ['---', 'name: test-skill', 'description: A test skill', 'extra: 123', '---', '', '# Body', ''].join(
      '\n',
    );

    const { data, body } = parseFrontmatter(text);

    expect(data).toEqual({
      name: 'test-skill',
      description: 'A test skill',
      extra: 123,
    });
    expect(body).not.toContain('extra: 123');
    expect(body).toContain('# Body');
  });

  it('throws FrontmatterError on invalid YAML', () => {
    const text = ['---', 'name: "unterminated', 'description: oops', '---', ''].join('\n');

    expect(() => parseFrontmatter(text)).toThrow(FrontmatterError);
  });
});
