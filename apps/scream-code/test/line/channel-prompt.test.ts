import { describe, expect, it } from 'vitest';

import { buildChannelPrompt } from '#/line/channel-prompt';

describe('buildChannelPrompt', () => {
  it('names the platform the user is actually on', () => {
    expect(buildChannelPrompt('feishu')).toContain('Lark');
    expect(buildChannelPrompt('weixin')).toContain('WeChat');
  });

  it('describes the media capabilities the bridge actually has', () => {
    const prompt = buildChannelPrompt('feishu');
    // Inbound images arrive as image parts, files as paths; outbound is the
    // host tool; the only denied ability is screenshots.
    expect(prompt).toContain('arrive as image parts');
    expect(prompt).toContain('absolute paths');
    expect(prompt).toContain('line_send_media');
    expect(prompt).toContain('no screenshot or desktop-capture ability');
    expect(prompt).not.toContain('NOT delivered');
  });

  it('tells the model that slash commands are handled by the bridge', () => {
    expect(buildChannelPrompt('weixin')).toContain('/status, /model, /compact, /new, /help');
  });
});
