import { describe, expect, it } from 'vitest';

import { hexFromHexChannels, parseOsc11Background } from '#/tui/theme/terminal-background';

/** A real OSC 11 reply, framed the way the terminal sends it. */
const reply = (rgb: string): string => `\u001B]11;${rgb}\u0007`;

describe('parseOsc11Background', () => {
  it('reads mode and colour, so surfaces can be derived from the ground', () => {
    expect(parseOsc11Background(reply('rgb:0000/0000/0000'))).toEqual({
      theme: 'dark',
      hex: '#000000',
    });
    expect(parseOsc11Background(reply('rgb:ffff/ffff/ffff'))).toEqual({
      theme: 'light',
      hex: '#ffffff',
    });
    // VS Code's default dark ground — the one a fixed #16191f surface inverts on.
    expect(parseOsc11Background(reply('rgb:1e1e/1e1e/1e1e'))).toEqual({
      theme: 'dark',
      hex: '#1e1e1e',
    });
  });

  it('normalises 1-4 digit channels to a byte triplet', () => {
    expect(hexFromHexChannels('f', '0', '8')).toBe('#ff0088');
    expect(hexFromHexChannels('ff', '00', 'ff')).toBe('#ff00ff');
  });

  it('returns null when the payload is not an OSC 11 reply', () => {
    expect(parseOsc11Background('hello')).toBeNull();
    expect(parseOsc11Background(reply('rgb:2828/2a2a/3636'))).toEqual({
      theme: 'dark',
      hex: '#282a36',
    });
  });
});
