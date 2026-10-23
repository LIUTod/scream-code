import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import type { MarkedToken, Token } from "marked";
import { markdownTokens, safeMarkdownHref } from "@/lib/markdown";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function decodeText(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0" };
  return text.replaceAll(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value: string) => {
    if (!value.startsWith("#")) return named[value.toLowerCase()] ?? entity;
    const point = value[1]?.toLowerCase() === "x" ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\uFFFD";
  });
}
export function CodeBlock({ content, language }: { content: string; language?: string }) {
  const { t } = useI18n();
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  return (
    <div className="my-3 min-w-0 overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{language?.split(/\s/)[0]}</span>
        <button type="button" className="hover:text-foreground" onClick={() => {
          void (async () => {
            try { await navigator.clipboard.writeText(content); setCopy("done"); }
            catch { setCopy("failed"); }
          })();
        }}>{t(copy === "done" ? "transcript.copied" : "transcript.copyCode")}</button>
      </div>
      <pre className="max-h-96 overflow-auto p-3 font-mono text-[12px] leading-relaxed"><code>{content}</code></pre>
      {copy === "failed" ? <p className="px-3 pb-2 text-xs text-destructive" role="alert">{t("transcript.copyFailed")}</p> : null}
    </div>
  );
}

function renderTokens(tokens: readonly Token[]): ReactNode {
  return (tokens as readonly MarkedToken[]).map((token, index) => <Fragment key={index}>{renderToken(token)}</Fragment>);
}
function renderToken(token: MarkedToken): ReactNode {
  switch (token.type) {
    case "space": case "def": return null;
    case "html": return token.text; // React escapes it. It never becomes markup.
    case "text": return token.tokens ? renderTokens(token.tokens) : decodeText(token.text);
    case "escape": return decodeText(token.text);
    case "br": return <br />;
    case "hr": return <hr className="my-3 border-border" />;
    case "strong": return <strong>{renderTokens(token.tokens)}</strong>;
    case "em": return <em>{renderTokens(token.tokens)}</em>;
    case "del": return <del>{renderTokens(token.tokens)}</del>;
    case "codespan": return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{decodeText(token.text)}</code>;
    case "code": return <CodeBlock content={token.text} language={token.lang} />;
    case "paragraph": return <p className="my-2 whitespace-pre-wrap break-words first:mt-0 last:mb-0">{renderTokens(token.tokens)}</p>;
    case "heading": {
      const Tag = `h${Math.min(6, Math.max(1, token.depth))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className="mt-4 mb-2 font-semibold text-[1.05em] first:mt-0">{renderTokens(token.tokens)}</Tag>;
    }
    case "blockquote": return <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{renderTokens(token.tokens)}</blockquote>;
    case "list": {
      const Tag = token.ordered ? "ol" : "ul";
      return <Tag className={cn("my-2 space-y-1 pl-5", token.ordered ? "list-decimal" : "list-disc")} start={token.ordered && typeof token.start === "number" ? token.start : undefined}>
        {token.items.map((item, index) => <li key={index}>
          {item.task ? <input aria-label={decodeText(item.text)} checked={!!item.checked} disabled readOnly type="checkbox" className="mr-2" /> : null}
          {renderTokens(item.tokens)}
        </li>)}
      </Tag>;
    }
    case "list_item": return <li>{renderTokens(token.tokens)}</li>;
    case "link": case "image": {
      const href = safeMarkdownHref(decodeText(token.href));
      const children = token.type === "image" ? decodeText(token.text) : renderTokens(token.tokens);
      return href ? <a className="break-words underline underline-offset-2 hover:no-underline" href={href} rel="noreferrer noopener" target="_blank" title={token.title ?? undefined}>{children}</a> : <span>{children}</span>;
    }
    case "table": return <div className="my-3 max-w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <thead className="bg-muted/40"><tr>{token.header.map((cell, index) => <th className="border-b border-border px-3 py-2 font-medium" key={index} style={{ textAlign: token.align[index] ?? undefined }}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
        <tbody>{token.rows.map((row, index) => <tr className="border-b border-border last:border-b-0" key={index}>{row.map((cell, column) => <td className="px-3 py-2" key={column} style={{ textAlign: token.align[column] ?? undefined }}>{renderTokens(cell.tokens)}</td>)}</tr>)}</tbody>
      </table>
    </div>;
  }
}

/** Shared safe GFM body for thread/room replies and tool output. */
export const MessageBody = memo(function MessageBody({ content, className }: { content: string; className?: string }) {
  const tokens = useMemo(() => markdownTokens(content), [content]);
  return <div className={cn("min-w-0 text-[13.5px] leading-relaxed", className)}>{renderTokens(tokens)}</div>;
});
