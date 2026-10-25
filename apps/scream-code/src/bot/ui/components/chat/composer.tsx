import { IconArrowUp, IconPaperclip, IconPlayerStop, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { canSubmitDraft, composerDrafts, draftKey, type DraftMode, type DraftRequest } from "@/lib/draft";
import type { Attachment, Bot } from "../../../shared/contracts";
import { Button } from "@/components/ui/button";
import { getBotClient } from "@/lib/api/client";
import { queryKeys, runsQuery } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "composer.suggestion1",
  "composer.suggestion2",
  "composer.suggestion3",
] as const;

/** A keyed editor prevents mutation errors/focus/height from leaking across conversations. */
export function Composer(props: { bot: Bot; threadId: string }) {
  return <ThreadComposer {...props} key={draftKey(props.bot.id, props.threadId)} />;
}

function ThreadComposer({ bot, threadId }: { bot: Bot; threadId: string }) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const key = draftKey(bot.id, threadId);
  const draft = useSyncExternalStore(composerDrafts.subscribe, () => composerDrafts.get(key));
  const value = draft.value;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const runs = useQuery(runsQuery(bot.id));
  const threadRuns = (runs.data ?? []).filter((run) => run.threadId === threadId);
  const activeRun = threadRuns.find((run) => run.status === "running" || run.status === "waiting_user");
  const queued = threadRuns.filter((run) => run.status === "queued");
  const waiting = activeRun?.status === "waiting_user";
  const [files, setFiles] = useState<readonly Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend = (text: string) =>
    uploading === 0 &&
    canSubmitDraft(text, bot.paused, draft.pending !== null || draft.retry !== null);
  const refresh = (ownerBotId: string, ownerThreadId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages(ownerThreadId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs(ownerBotId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.threads(ownerBotId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bot(ownerBotId) });
  };

  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 208)}px`;
  }, [value]);

  const send = useMutation({
    retry: false,
    mutationFn: (request: DraftRequest) =>
      getBotClient().prompt(request.threadId, {
        mode: request.mode,
        text: request.text,
        requestKey: request.id,
        attachments: request.attachments ?? [],
      }),
    onSuccess: (_accepted, request) => {
      // Acceptance transfers ownership to the server. Never clear the live editor here.
      composerDrafts.finish(request);
      refresh(request.botId, request.threadId);
    },
    onError: (error, request) => { composerDrafts.finish(request, error.message || t("composer.sendFailed")); },
  });
  const stop = useMutation({
    retry: false,
    mutationFn: () => getBotClient().interrupt(threadId),
    onSettled: () => { refresh(bot.id, threadId); },
  });
  const cancel = useMutation({
    retry: false,
    mutationFn: (runId: string) => getBotClient().cancelRun(runId),
    onSettled: () => { refresh(bot.id, threadId); },
  });
  const attach = async (picked: FileList | null) => {
    if (picked === null || picked.length === 0) return;
    const room = Math.max(0, 10 - files.length);
    const batch = Array.from(picked).slice(0, room);
    if (batch.length < picked.length) setFileError(t("composer.tooManyFiles", { max: 10 }));
    setUploading((count) => count + batch.length);
    for (const file of batch) {
      try {
        // The upload must land in the workspace this thread's runs actually open.
        const saved = await getBotClient().uploadAttachment(bot.id, file, threadId);
        setFiles((current) => [...current, saved]);
      } catch (error) {
        setFileError(error instanceof Error ? error.message : t("composer.uploadFailed"));
      } finally {
        setUploading((count) => Math.max(0, count - 1));
      }
    }
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  const submit = (text: string, mode: DraftMode = "queue", consume = true) => {
    if (uploading > 0) return;
    const request = composerDrafts.begin(bot.id, threadId, text, bot.paused, mode, consume, files);
    if (request !== null && files.length > 0) setFiles([]);
    if (request) send.mutate(request);
  };

  return (
    <div className="shrink-0 px-4 pb-4 md:px-8 md:pb-5">
      <div className="mx-auto w-full max-w-3xl">
        {!activeRun ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((suggestion) => {
              const label = t(suggestion);
              return (
                <button
                  className="rounded-full border border-border bg-background px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                  key={suggestion}
                  disabled={!canSend(label)}
                  onClick={() => { submit(label, "queue", false); }}
                  type="button"
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        <div
          className={cn(
            "rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-foreground/20",
            waiting ? "border-warning/40" : "",
          )}
        >
          <textarea
            aria-label={t("composer.placeholder", { name: bot.name })}
            className="block max-h-52 min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              composerDrafts.edit(key, event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 208)}px`;
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit(value);
              }
            }}
            placeholder={
              bot.paused
                ? t("composer.paused", { name: bot.name })
                : t("composer.placeholder", { name: bot.name })
            }
            ref={textarea}
            rows={1}
            value={value}
          />
          {fileError !== null ? (
            <p className="px-2 pb-1.5 text-[11.5px] text-destructive" role="alert">
              {fileError}
            </p>
          ) : null}
          {files.length > 0 || uploading > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-2 pb-1.5">
              {files.map((file) => (
                <span
                  className="flex max-w-[220px] items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-[11.5px]"
                  key={file.id}
                >
                  <IconPaperclip className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{file.name}</span>
                  <button
                    aria-label={t("composer.removeAttachment", { name: file.name })}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setFiles((current) => current.filter((entry) => entry.id !== file.id))}
                    type="button"
                  >
                    <IconX className="size-3" />
                  </button>
                </span>
              ))}
              {uploading > 0 ? (
                <span className="rounded-lg bg-muted px-2 py-1 text-[11.5px] text-muted-foreground">
                  {t("composer.attaching", { count: uploading })}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center gap-2 px-2 pb-2">
            <Button
              aria-label={t("composer.attach")}
              className="h-7 px-2 text-muted-foreground"
              disabled={uploading > 0}
              onClick={() => fileInput.current?.click()}
              size="sm"
              variant="ghost"
            >
              <IconPaperclip className="size-4" />
            </Button>
            <input
              className="hidden"
              multiple
              onChange={(event) => { void attach(event.target.files); }}
              ref={fileInput}
              type="file"
            />
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
              {waiting
                ? t("composer.waiting")
                : t("composer.enterToSend")}
            </span>
            {activeRun ? (
              <Button
                aria-label={t("composer.stop")}
                disabled={stop.isPending}
                onClick={() => { stop.mutate(); }}
                size="icon-sm"
                variant="outline"
              >
                <IconPlayerStop className="size-4" />
              </Button>
            ) : null}
            {activeRun?.status === "running" ? (
              <Button className="h-7 px-2 text-[12px]" disabled={!canSend(value)} onClick={() => { submit(value, "steer"); }} size="sm" variant="ghost">
                {t("composer.steer")}
              </Button>
            ) : null}
            <Button
              aria-label={t("composer.send")}
              className="rounded-full"
              disabled={!canSend(value)}
              onClick={() => { submit(value); }}
              size="icon-sm"
            >
              <IconArrowUp className="size-4" />
            </Button>
          </div>
        </div>
        {queued.map((run) => (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" key={run.id}>
            <span>{t("run.queued")}</span>
            <Button disabled={cancel.isPending} onClick={() => { cancel.mutate(run.id); }} size="sm" variant="ghost">
              {t("composer.cancelQueued")}
            </Button>
          </div>
        ))}
        {draft.retry ? (
          <section aria-label={t("composer.unconfirmedText")} className="mt-2 rounded-lg border border-border bg-muted/40 p-2.5 text-xs" data-slot="unconfirmed-prompt">
            <p className="text-muted-foreground" role="status">{t("composer.unconfirmed")}</p>
            {draft.recovered ? <p className="mt-1 text-muted-foreground">{t("composer.recoveredDraft")}</p> : null}
            <pre className="my-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">{draft.retry.restore}</pre>
            <Button disabled={!canSubmitDraft(draft.retry.text, bot.paused, draft.pending !== null)} onClick={() => {
              const request = composerDrafts.retry(bot.id, threadId, bot.paused);
              if (request) send.mutate(request);
            }} size="sm" variant="outline">{t("composer.retryRequest")}</Button>
          </section>
        ) : null}
        {draft.error ? <p className="mt-2 text-destructive text-xs" role="alert">{t("composer.sendFailed")}: {draft.error}</p> : null}
        {stop.error ? <p className="mt-2 text-destructive text-xs" role="alert">{t("composer.stopFailed")}: {stop.error.message}</p> : null}
        {cancel.error ? <p className="mt-2 text-destructive text-xs" role="alert">{t("composer.cancelFailed")}: {cancel.error.message}</p> : null}
      </div>
    </div>
  );
}
