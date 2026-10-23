import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Room } from "../../../shared/contracts";
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
import { getBotClient } from "@/lib/api/client";
import { botsQuery, roomsQuery } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";

/** Create a shared transcript with a chosen set of Bots and a lead Bot. */
export function NewRoomSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (room: Room) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const bots = useQuery(botsQuery());
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [lead, setLead] = useState("");
  const create = useMutation({
    mutationFn: () =>
      getBotClient().createRoom({
        name: name.trim(),
        memberIds: members,
        ...(lead.length > 0 ? { leadBotId: lead } : {}),
      }),
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: roomsQuery().queryKey });
      onCreated?.(room);
      onOpenChange(false);
      setName("");
      setMembers([]);
      setLead("");
    },
  });

  const toggleMember = (botId: string): void => {
    setMembers((current) => {
      const next = current.includes(botId)
        ? current.filter((id) => id !== botId)
        : [...current, botId];
      if (!next.includes(lead)) setLead(next[0] ?? "");
      return next;
    });
  };

  const canCreate = name.trim().length > 0 && members.length > 0 && !create.isPending;

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("room.new")}</SheetTitle>
          <SheetDescription>{t("room.newDescription")}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="room-name">{t("room.name")}</FieldLabel>
              <Input
                id="room-name"
                onChange={(event) => setName(event.target.value)}
                placeholder={t("room.namePlaceholder")}
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel>{t("room.members")}</FieldLabel>
              <div className="grid grid-cols-2 gap-1.5">
                {(bots.data ?? []).map((bot) => {
                  const active = members.includes(bot.id);
                  return (
                    <button
                      aria-pressed={active}
                      className={`rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                        active
                          ? "border-foreground/40 bg-sidebar-accent text-foreground"
                          : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground"
                      }`}
                      key={bot.id}
                      onClick={() => toggleMember(bot.id)}
                      type="button"
                    >
                      {bot.name}
                    </button>
                  );
                })}
              </div>
              <FieldDescription>{t("room.membersHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="room-lead">{t("room.leadLabel")}</FieldLabel>
              <select
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-[13px]"
                id="room-lead"
                onChange={(event) => setLead(event.target.value)}
                value={lead}
              >
                {members.map((id) => {
                  const bot = bots.data?.find((entry) => entry.id === id);
                  return (
                    <option key={id} value={id}>
                      {bot?.name ?? id}
                    </option>
                  );
                })}
              </select>
            </Field>
          </FieldGroup>
          <SheetFooter className="mt-auto flex flex-row justify-end gap-2">
            <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
              {t("room.cancel")}
            </Button>
            <Button disabled={!canCreate} size="sm" type="submit">
              {create.isPending ? t("room.creating") : t("room.create")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
