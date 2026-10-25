import { IconPaperclip } from "@tabler/icons-react";

import type { Attachment } from "../../../shared/contracts";

/** Files that travelled with a message, shown as chips under it. */
export function AttachmentChips({
  attachments,
  align = "start",
}: {
  attachments: readonly Attachment[] | undefined;
  align?: "start" | "end";
}) {
  if (attachments === undefined || attachments.length === 0) return null;
  return (
    <div
      className={
        align === "end"
          ? "mt-1.5 flex flex-wrap justify-end gap-1.5"
          : "mt-1.5 flex flex-wrap gap-1.5"
      }
    >
      {attachments.map((file) => (
        <span
          className="flex max-w-[240px] items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-[11.5px]"
          key={file.id}
          title={file.path}
        >
          <IconPaperclip className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{file.name}</span>
        </span>
      ))}
    </div>
  );
}
