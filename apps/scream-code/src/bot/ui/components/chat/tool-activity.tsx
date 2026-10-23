import { IconTool } from "@tabler/icons-react";
import { useId, useState } from "react";
import type { ToolCall } from "../../../shared/contracts";
import { useI18n } from "@/lib/i18n";
import { MessageBody } from "./message-body";
import { ToolRenderBoundary } from "./tool-boundary";

function inputText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function LongOutput({ content, markdown = false }: { content: string; markdown?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const preview = content.split("\n").slice(0, 16).join("\n").slice(0, 1800);
  const long = preview.length < content.length;
  const shown = long && !expanded ? `${preview}\n…` : content;
  return <div className="min-w-0">
    <div id={id}>{markdown ? <MessageBody content={shown} /> : <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed">{shown}</pre>}</div>
    {long ? <button aria-controls={id} aria-expanded={expanded} className="mt-1 text-xs text-muted-foreground underline underline-offset-2" onClick={() => { setExpanded(!expanded); }} type="button">{t(expanded ? "transcript.collapse" : "transcript.expand")}</button> : null}
  </div>;
}
function ToolStep({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const input = inputText(call.args);
  const status = call.status === "running" ? "run.running" : call.status === "error" ? "run.failed" : "run.done";
  return <details className="tool-line my-1.5 min-w-0">
    <summary className="flex cursor-pointer list-none items-baseline gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="tool-line-chevron shrink-0 transition-transform">▸</span>
      <span className={call.status === "running" ? "tool-line-running" : undefined}>{call.name}</span>
      <span className={call.status === "error" ? "text-destructive" : undefined}>{t(status)}</span>
    </summary>
    <div className="mt-2 space-y-2 border-l border-border pl-3">
      {input !== undefined ? <section><h4 className="mb-1 text-xs text-muted-foreground">{t("transcript.input")}</h4><LongOutput content={input} /></section> : null}
      {call.output !== undefined ? <section><h4 className="mb-1 text-xs text-muted-foreground">{t("transcript.output")}</h4><LongOutput content={call.output} markdown /></section> : null}
      {call.error ? <p className="whitespace-pre-wrap break-words text-xs text-destructive" role="alert">{call.error}</p> : null}
    </div>
  </details>;
}
export function ToolActivity({ calls }: { calls: readonly ToolCall[] }) {
  const { t } = useI18n();
  const steps = calls.map((call) => <ToolRenderBoundary key={call.id} name={call.name}><ToolStep call={call} /></ToolRenderBoundary>);
  if (calls.length === 0) return null;
  if (calls.length === 1) return <div className="mt-1">{steps}</div>;
  const running = calls.some((call) => call.status === "running");
  const failed = calls.some((call) => call.status === "error");
  return <details className="tool-line my-1.5 min-w-0">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="tool-line-chevron shrink-0 transition-transform">▸</span><IconTool aria-hidden className="size-3.5" />
      <span className={running ? "tool-line-running" : undefined}>{t("transcript.tools", { count: calls.length })}</span>
      {failed ? <span className="text-destructive">{t("run.failed")}</span> : running ? <span>{t("run.running")}</span> : null}
    </summary>
    <div className="mt-2 border-l border-border pl-3">{steps}</div>
  </details>;
}
