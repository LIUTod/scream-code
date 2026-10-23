import {
  IconFileText,
  IconPencil,
  IconSearch,
  IconTerminal2,
  IconTool,
} from "@tabler/icons-react";
import type { ToolCall } from "../../../shared/contracts";
import { ToolLine } from "@/components/channels/tool-line";
import { cn } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function kindOf(name: string): "bash" | "edit" | "read" | "other" {
  const normalized = name.toLowerCase();
  if (/bash|shell|exec|command|terminal/.test(normalized)) return "bash";
  if (/edit|write|patch|apply/.test(normalized)) return "edit";
  if (/read|grep|search|glob|list|find/.test(normalized)) return "read";
  return "other";
}

function preview(value: string, limit: number): string {
  const firstLine = value.split("\n")[0] ?? value;
  return firstLine.length > limit ? `${firstLine.slice(0, limit - 1)}…` : firstLine;
}

function DiffBlock({
  oldText,
  newText,
}: {
  oldText: string;
  newText: string;
}) {
  const removed = oldText.split("\n").filter((line) => line.length > 0);
  const added = newText.split("\n").filter((line) => line.length > 0);
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed">
      {removed.map((line, index) => (
        <div
          className="whitespace-pre-wrap break-all text-destructive/90"
          key={`old-${index}`}
        >
          <span aria-hidden className="select-none opacity-60">
            -{" "}
          </span>
          {line}
        </div>
      ))}
      {added.map((line, index) => (
        <div
          className="whitespace-pre-wrap break-all text-success"
          key={`new-${index}`}
        >
          <span aria-hidden className="select-none opacity-60">
            +{" "}
          </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

function Output({ value }: { value: string }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground/80">
      {value}
    </pre>
  );
}

/**
 * One tool call, drawn as the kind of thing it did rather than as JSON.
 *
 * Every card collapses to a single line. The one still running keeps its line shimmering, which is
 * the only signal available while a command produces nothing yet.
 */
export function ToolCard({ call }: { call: ToolCall }) {
  const args = asRecord(call.args);
  const kind = kindOf(call.name);
  const command =
    text(args["command"]) ?? text(args["cmd"]) ?? text(args["script"]);
  const path =
    text(args["file_path"]) ?? text(args["path"]) ?? text(args["file"]);
  const pattern = text(args["pattern"]) ?? text(args["query"]);

  if (kind === "bash") {
    const output = call.error ?? call.output;
    return (
      <ToolLine
        detail={command ? preview(command, 72) : undefined}
        failed={call.status === "error"}
        icon={<IconTerminal2 className="size-3.5" />}
        label={call.status === "running" ? "Running a command" : "Ran a command"}
        running={call.status === "running"}
      >
        {command ? <Output value={`$ ${command}`} /> : null}
        {output ? <Output value={output} /> : null}
      </ToolLine>
    );
  }

  if (kind === "edit") {
    const oldText = text(args["old_string"]) ?? "";
    const newText =
      text(args["new_string"]) ?? text(args["content"]) ?? text(args["contents"]) ?? "";
    return (
      <ToolLine
        detail={path ? baseName(path) : undefined}
        failed={call.status === "error"}
        icon={<IconPencil className="size-3.5" />}
        label={call.status === "running" ? "Editing" : "Edited"}
        running={call.status === "running"}
      >
        {oldText || newText ? (
          <DiffBlock newText={newText} oldText={oldText} />
        ) : null}
        {call.output ? <Output value={call.output} /> : null}
      </ToolLine>
    );
  }

  if (kind === "read") {
    return (
      <ToolLine
        detail={
          path ? baseName(path) : pattern ? preview(pattern, 48) : undefined
        }
        failed={call.status === "error"}
        icon={
          pattern ? (
            <IconSearch className="size-3.5" />
          ) : (
            <IconFileText className="size-3.5" />
          )
        }
        label={pattern ? "Searched" : call.status === "running" ? "Reading" : "Read"}
        running={call.status === "running"}
      >
        {path ? <Output value={path} /> : null}
        {call.output ? <Output value={call.output} /> : null}
      </ToolLine>
    );
  }

  const input = text(call.args);
  return (
    <ToolLine
      detail={path ? baseName(path) : undefined}
      failed={call.status === "error"}
      icon={<IconTool className="size-3.5" />}
      label={call.name}
      running={call.status === "running"}
    >
      {input ? <Output value={input} /> : null}
      {call.output ? <Output value={call.output} /> : null}
    </ToolLine>
  );
}

export function ToolCallList({ calls }: { calls: readonly ToolCall[] }) {
  if (!calls.length) return null;
  return (
    <div className={cn("mt-1 flex flex-col")}>
      {calls.map((call) => (
        <ToolCard call={call} key={call.id} />
      ))}
    </div>
  );
}
