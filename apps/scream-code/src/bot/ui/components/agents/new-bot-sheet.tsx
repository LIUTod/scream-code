import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { Bot, BotPermission } from "../../../shared/contracts";
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
import { useI18n } from "@/lib/i18n";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function NewBotSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [workspace, setWorkspace] = useState("~");
  const [rolePrompt, setRolePrompt] = useState("");
  const [permission, setPermission] = useState<BotPermission>("bot");
  const create = useMutation({
    mutationFn: () =>
      getBotClient().createBot({
        name,
        permission,
        rolePrompt:
          rolePrompt.trim() ||
          `You are ${name.trim() || "a Bot"}. Help the person with whatever they bring you, clearly and briefly.`,
        title,
        workspace,
      }),
    onSuccess: (bot) => {
      onCreated(bot);
      setName("");
      setTitle("");
      setRolePrompt("");
    },
  });

  const canCreate =
    name.trim().length > 0 && workspace.trim().length > 0 && !create.isPending;

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
          <SheetTitle>{t("bot.new.title")}</SheetTitle>
          <SheetDescription>{t("bot.new.description")}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bot-name">{t("bot.new.name")}</FieldLabel>
                <Input
                  autoFocus
                  id="bot-name"
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("bot.new.namePlaceholder")}
                  value={name}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bot-title">{t("bot.new.role")}</FieldLabel>
                <Input
                  id="bot-title"
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t("bot.new.rolePlaceholder")}
                  value={title}
                />
                <FieldDescription>
                  {t("bot.new.roleHint")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="bot-workspace">{t("bot.new.workspace")}</FieldLabel>
                <Input
                  className="font-mono text-[13px]"
                  id="bot-workspace"
                  onChange={(event) => setWorkspace(event.target.value)}
                  placeholder={t("bot.new.workspacePlaceholder")}
                  value={workspace}
                />
                <FieldDescription>
                  {t("bot.new.workspaceHint")}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="bot-permission">{t("bot.new.permissions")}</FieldLabel>
                <select
                  className={selectClass}
                  id="bot-permission"
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
                <FieldLabel htmlFor="bot-prompt">{t("bot.new.instructions")}</FieldLabel>
                <Textarea
                  className="min-h-28"
                  id="bot-prompt"
                  onChange={(event) => setRolePrompt(event.target.value)}
                  placeholder={t("bot.new.instructionsPlaceholder")}
                  value={rolePrompt}
                />
              </Field>
            </FieldGroup>
            {create.error ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {create.error.message}
              </p>
            ) : null}
          </div>
          <SheetFooter className="border-t border-border">
            <div className="flex justify-end gap-2">
              <Button onClick={onClose} size="sm" type="button" variant="ghost">
                {t("bot.new.cancel")}
              </Button>
              <Button disabled={!canCreate} size="sm" type="submit">
                {create.isPending ? t("bot.new.creating") : t("bot.new.create")}
              </Button>
            </div>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
