/**
 * Channel capability note injected into every /line session.
 *
 * Without it the model has no idea it is answering over an IM channel: it
 * advertises desktop-only abilities (screenshots, image attachments, slash
 * pickers) and then fails. The note is appended to the runtime system prompt
 * (SDK `Session.setRuntimeSystemPrompt`) so it never pollutes the transcript.
 *
 * Keep this in sync with the actual platform capabilities — it is the model's
 * only source of truth about the channel.
 */

export type LinePlatform = 'feishu' | 'weixin';

export function buildChannelPrompt(platform: LinePlatform): string {
  const name = platform === 'feishu' ? 'Lark' : 'WeChat';
  return [
    '## Channel context (IM bridge)',
    `You are replying to the user over ${name} through the /line bridge, not in a desktop terminal.`,
    '- Replies are plain text. Very long answers are split into several messages automatically; no markdown rendering is guaranteed beyond fenced code blocks.',
    '- Inbound: text arrives as usual; images the user sends arrive as image parts of their message, and files arrive as absolute paths you can open with your own tools (ReadMediaFile for images).',
    '- Outbound: use the `line_send_media` tool to send a local image or file back to this chat (working-directory files only, max 25 MiB). You have no screenshot or desktop-capture ability — never offer to take a screenshot.',
    '- Slash commands from the user are handled by the bridge before they reach you (/status, /model, /compact, /new, /help). If one slips through as plain text, say the command is handled outside the conversation.',
  ].join('\n');
}
