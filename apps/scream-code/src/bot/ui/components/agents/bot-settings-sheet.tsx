import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Bot, BotPermission, UpdateBotInput } from "../../../shared/contracts";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { getBotClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries";
import { forgetDeletedBot } from "@/lib/session";
import { useI18n } from "@/lib/i18n";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** Everything about a Bot that is not its conversation. */
export function BotSettingsSheet({
  bot,
  open,
  onClose,
  onDeleted,
}: {
  bot: Bot;
  open: boolean;
  onClose: () => void;
  onDeleted: (botId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [workspace, setWorkspace] = useState(bot.workspace);
  const [rolePrompt, setRolePrompt] = useState(bot.rolePrompt);
  const [permission, setPermission] = useState<BotPermission>(bot.permission);
  const [confirming, setConfirming] = useState(false);
  const openedBot = useRef<string | null>(null);
  const active = useRef({ botId: bot.id, open });
  active.current = { botId: bot.id, open };

  useEffect(() => {
    if (!open) { openedBot.current = null; return; }
    // Background polling must not overwrite edits in an open settings form.
    if (openedBot.current === bot.id) return;
    openedBot.current = bot.id;
    setName(bot.name);
    setTitle(bot.title);
    setWorkspace(bot.workspace);
    setRolePrompt(bot.rolePrompt);
    setPermission(bot.permission);
    setConfirming(false);
  }, [bot, open]);

  const refresh = (botId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.bots() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bot(botId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.threads(botId) });
  };

  const save = useMutation({
    retry: false,
    mutationFn: (operation: { botId: string; input: UpdateBotInput }) =>
      getBotClient().updateBot(operation.botId, operation.input),
    onSuccess: (_saved, operation) => { refresh(operation.botId); },
  });

  const pause = useMutation({
    retry: false,
    mutationFn: (operation: { botId: string; paused: boolean }) => getBotClient().setPaused(operation.botId, operation.paused),
    onSuccess: (_updated, operation) => { refresh(operation.botId); },
  });

  const remove = useMutation({
    retry: false,
    mutationFn: (botId: string) => getBotClient().deleteBot(botId),
    onSuccess: async (_result, deletedBotId) => {
      forgetDeletedBot(deletedBotId, queryClient);
      if (active.current.botId === deletedBotId && active.current.open) onClose();
      onDeleted(deletedBotId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.bots() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox() });
    },
  });

  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <SheetContent
        className="gap-0 data-[side=right]:w-[calc(100%-1rem)] data-[side=right]:sm:max-w-lg"
        side="right"
        variant="inset"
      >
        <SheetHeader className="border-b border-border pb-3">
          <SheetTitle>{bot.name}</SheetTitle>
          <SheetDescription>{t("bot.settings.description")}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (save.isPending) return;
            save.mutate({ botId: bot.id, input: { name, permission, rolePrompt, title, workspace } });
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-name">{t("bot.new.name")}</FieldLabel>
                <Input
                  id="settings-name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-title">{t("bot.new.role")}</FieldLabel>
                <Input
                  id="settings-title"
                  onChange={(event) => setTitle(event.target.value)}
                  value={title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-workspace">{t("bot.new.workspace")}</FieldLabel>
                <Input
                  className="font-mono text-[13px]"
                  id="settings-workspace"
                  onChange={(event) => setWorkspace(event.target.value)}
                  value={workspace}
                />
                <FieldDescription>
                  {t("bot.settings.workspaceHint")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-permission">{t("bot.new.permissions")}</FieldLabel>
                <select
                  className={selectClass}
                  id="settings-permission"
                  onChange={(event) =>
                    setPermission(event.target.value as BotPermission)
                  }
                  value={permission}
                >
                  <option value="bot">{t("bot.permission.bot")}</option>
                  <option value="auto">{t("bot.permission.auto")}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-prompt">{t("bot.new.instructions")}</FieldLabel>
                <Textarea
                  className="min-h-28"
                  id="settings-prompt"
                  onChange={(event) => setRolePrompt(event.target.value)}
                  value={rolePrompt}
                />
              </Field>
            </FieldGroup>
            <p className="mt-3 text-muted-foreground text-xs">{t("bot.settings.sharedMemory")}</p>

            <div className="mt-6 rounded-lg border border-border p-3">
              <p className="font-medium text-[13px]">
                {bot.paused ? t("bot.settings.pausedTitle") : t("bot.settings.pauseTitle")}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t("bot.settings.pauseDescription")}
              </p>
              <Button
                className="mt-2"
                disabled={pause.isPending}
                onClick={() => pause.mutate({ botId: bot.id, paused: !bot.paused })}
                size="sm"
                type="button"
                variant="outline"
              >
                {bot.paused ? t("bot.settings.resume") : t("bot.settings.pause")}
              </Button>
            </div>

            <div className="mt-4 rounded-lg border border-destructive/30 p-3">
              <p className="font-medium text-[13px]">{t("bot.settings.delete")}</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t("bot.settings.deleteDescription")}
              </p>
              {confirming ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    disabled={remove.isPending}
                    onClick={() => { if (!remove.isPending) remove.mutate(bot.id); }}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    {remove.isPending ? t("bot.settings.deleting") : t("bot.settings.deletePermanently")}
                  </Button>
                  <Button
                    onClick={() => setConfirming(false)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("bot.settings.cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  className="mt-2"
                  onClick={() => setConfirming(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("bot.settings.deleteTrigger")}
                </Button>
              )}
              {remove.error ? (
                <p className="mt-2 text-destructive text-xs" role="alert">
                  {remove.error.message}
                </p>
              ) : null}
            </div>
            {pause.error ? <p className="mt-3 text-destructive text-sm" role="alert">{pause.error.message}</p> : null}
            {save.error ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </div>
          <SheetFooter className="border-t border-border">
            <div className="flex justify-end gap-2">
              <Button onClick={onClose} size="sm" type="button" variant="ghost">
                {t("bot.settings.cancel")}
              </Button>
              <Button disabled={save.isPending} size="sm" type="submit">
                {save.isPending ? t("bot.settings.saving") : t("bot.settings.saveChanges")}
              </Button>
            </div>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
