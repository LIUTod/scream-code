import { Lexer, type MarkedToken } from "marked";

/** Use the installed GFM parser, not generated HTML or a hand-rolled Markdown grammar. */
export function markdownTokens(content: string): MarkedToken[] {
  return Lexer.lex(content, { gfm: true }) as MarkedToken[];
}

/** Deny active/local schemes and protocol-relative navigation, even with hidden controls. */
export function safeMarkdownHref(href: string): string | undefined {
  const cleaned = href.trim();
  if (!cleaned || /[\u0000-\u0020\u007F]/.test(cleaned) || /[\\]/.test(cleaned) || cleaned.startsWith("//")) return undefined;
  if (cleaned.startsWith("#")) return cleaned;
  try {
    const url = new URL(cleaned);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? cleaned : undefined;
  } catch { return undefined; }
}
