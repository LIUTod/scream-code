/**
 * Outbound message formatting for Feishu.
 *
 * Port of the reference `platform/feishu/feishu.go` reply-format decision
 * (buildReplyContent L3644, containsMarkdown, preprocessFeishuMarkdown,
 * buildPostMdJSON, sanitizeMarkdownURLs) with one documented P1
 * simplification: all markdown content is sent as a post message with the
 * `md` tag (renders markdown at normal chat font size). the reference prefers
 * interactive cards; card building/streaming is P2.
 */

export const MAX_REPLY_CHARS = 30_000;

const MARKDOWN_INDICATORS = ['```', '**', '~~', '`', '\n- ', '\n* ', '\n1. ', '\n# ', '---'] as const;

/** True when the content needs markdown rendering (the reference containsMarkdown). */
export function containsMarkdown(s: string): boolean {
  return MARKDOWN_INDICATORS.some((ind) => s.includes(ind));
}

/**
 * Ensure a code fence has a newline before it, which prevents rendering
 * issues in Feishu markdown (the reference preprocessFeishuMarkdown).
 */
export function preprocessFeishuMarkdown(md: string): string {
  const b: string[] = [];
  for (let i = 0; i < md.length; i++) {
    if (i > 0 && md.charAt(i) === '`' && md.charAt(i + 1) === '`' && md.charAt(i + 2) === '`' && md.charAt(i - 1) !== '\n') {
      b.push('\n');
    }
    b.push(md.charAt(i));
  }
  return b.join('');
}

function isValidFeishuHref(u: string): boolean {
  return u.startsWith('http://') || u.startsWith('https://');
}

// [text](href) — the same regex as the reference's mdLinkRe.
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Rewrite markdown links with non-HTTP(S) schemes to plain text, preventing
 * Feishu API rejection code 230001 (the reference sanitizeMarkdownURLs).
 * Native card-image syntax `![alt](...)` is left alone.
 */
export function sanitizeMarkdownURLs(md: string): string {
  const b: string[] = [];
  let last = 0;
  for (const match of md.matchAll(MD_LINK_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > 0 && md.charAt(start - 1) === '!') continue;
    const text = match[1] ?? '';
    const href = match[2] ?? '';
    b.push(md.slice(last, start));
    if (isValidFeishuHref(href)) {
      b.push(match[0]);
    } else {
      b.push(`${text} (${href})`);
    }
    last = end;
  }
  if (last === 0) return md;
  b.push(md.slice(last));
  return b.join('');
}

/**
 * Feishu only fires mention events for <at> tags inside text messages, not
 * inside cards/post — force plain text when a resolved mention is present
 * (the reference buildReplyContent).
 */
function hasResolvedMention(content: string): boolean {
  return content.includes('<at user_id=') || content.includes('<at id=');
}

export type FeishuOutboundMsgType = 'text' | 'post';

export interface FeishuOutbound {
  msgType: FeishuOutboundMsgType;
  /** JSON-encoded `content` body for the im.message send/reply APIs. */
  body: string;
}

/**
 * Decide text vs post-md and build the JSON body (the reference buildReplyContent,
 * P1: markdown → post md tag instead of interactive card).
 */
export function buildReplyContent(content: string): FeishuOutbound {
  if (!containsMarkdown(content) || hasResolvedMention(content)) {
    return { msgType: 'text', body: JSON.stringify({ text: content }) };
  }
  const processed = sanitizeMarkdownURLs(preprocessFeishuMarkdown(content));
  return {
    msgType: 'post',
    body: JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'md', text: processed }]],
      },
    }),
  };
}

/** Truncate very long replies so the total (including the notice) stays bounded. */
export function truncateForLine(content: string, maxChars = MAX_REPLY_CHARS): string {
  if (content.length <= maxChars) return content;
  const NOTICE = '\n\n……（回复过长已截断，完整内容请在 scream 会话中查看）';
  const keep = Math.max(0, maxChars - NOTICE.length);
  return content.slice(0, keep) + NOTICE;
}

/** Plain-text JSON body for short notices (errors, unauthorized replies). */
export function buildTextJSON(text: string): string {
  return JSON.stringify({ text });
}
