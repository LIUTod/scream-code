import { describe, expect, it } from 'vitest';

import { buildRoleAdditionalText } from '#/tui/commands/like';

describe('buildRoleAdditionalText', () => {
  it('returns an empty string when no preferences are set', () => {
    expect(buildRoleAdditionalText({})).toBe('');
  });

  it('includes the nickname when set', () => {
    const result = buildRoleAdditionalText({ nickname: 'Alex' });
    expect(result).toContain('HIGHEST PRIORITY');
    expect(result).toContain('- Nickname: address the user as "Alex".');
  });

  it('includes the tone when set', () => {
    const result = buildRoleAdditionalText({ tone: 'friendly' });
    expect(result).toContain('- Tone: respond in friendly tone.');
  });

  it('includes other preferences verbatim', () => {
    const result = buildRoleAdditionalText({ other: 'use Chinese, avoid abbreviations' });
    expect(result).toContain('- Other: use Chinese, avoid abbreviations');
  });

  it('combines all fields in order', () => {
    const result = buildRoleAdditionalText({
      nickname: 'Alex',
      tone: 'friendly',
      other: 'use examples',
    });
    const nicknameIdx = result.indexOf('Nickname:');
    const toneIdx = result.indexOf('Tone:');
    const otherIdx = result.indexOf('Other:');
    expect(nicknameIdx).toBeGreaterThan(-1);
    expect(toneIdx).toBeGreaterThan(nicknameIdx);
    expect(otherIdx).toBeGreaterThan(toneIdx);
    expect(result).toContain('address the user as "Alex"');
    expect(result).toContain('respond in friendly tone');
    expect(result).toContain('use examples');
  });

  it('trims whitespace from inputs', () => {
    const result = buildRoleAdditionalText({ nickname: '  Alex  ', tone: '  concise ' });
    expect(result).toContain('address the user as "Alex"');
    expect(result).toContain('respond in concise tone');
  });

  it('ignores fields that are empty after trimming', () => {
    const result = buildRoleAdditionalText({ nickname: '   ', tone: 'calm', other: '' });
    expect(result).not.toContain('Nickname');
    expect(result).toContain('- Tone: respond in calm tone.');
    expect(result).not.toContain('Other');
  });

  it('marks the block as highest priority with bilingual anchor', () => {
    const result = buildRoleAdditionalText({ nickname: 'Alex' });
    expect(result).toContain('HIGHEST PRIORITY');
    expect(result).toContain('MUST');
    expect(result).toContain('用户通过 /like 设置的偏好具有最高优先级');
  });
});
