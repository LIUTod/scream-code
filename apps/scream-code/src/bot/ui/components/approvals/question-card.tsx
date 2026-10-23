import { IconMessageQuestion } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Question, QuestionItem } from "../../../shared/contracts";
import { Button } from "@/components/ui/button";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { getBotClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries";
import { useI18n } from "@/lib/i18n";

type AnswerState = Record<string, string[]>;

function OtherField({
  itemId,
  onChange,
  value,
}: {
  itemId: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useI18n();
  return (
    <QuestionnaireInput
      aria-label={t("question.otherAria", { id: itemId })}
      onChange={(event) => onChange(event.target.value)}
      placeholder={t("question.other")}
      value={value}
    />
  );
}

function ItemField({
  answers,
  item,
  onOther,
  onToggle,
  other,
  disabled,
  name,
}: {
  disabled: boolean;
  name: string;
  answers: string[];
  item: QuestionItem;
  onOther: (value: string) => void;
  onToggle: (label: string) => void;
  other: string;
}) {
  return (
    <QuestionnaireItem disabled={disabled}>
      <QuestionnaireTitle>{item.question}</QuestionnaireTitle>
      <QuestionnaireChoices>
        {item.options.map((option) => {
          const checked = answers.includes(option.label);
          return (
            <QuestionnaireChoice
              checked={checked}
              name={name}
              value={option.label}
              key={option.label}
              onChange={() => onToggle(option.label)}
              type={item.multiple ? "checkbox" : "radio"}
            >
              {option.label}
              {option.description ? (
                <QuestionnaireChoiceDescription>
                  {option.description}
                </QuestionnaireChoiceDescription>
              ) : null}
            </QuestionnaireChoice>
          );
        })}
      </QuestionnaireChoices>
      {item.allowOther ? (
        <OtherField itemId={item.id} onChange={onOther} value={other} />
      ) : null}
    </QuestionnaireItem>
  );
}

/** A Bot's question, answered where it was asked. */
export function QuestionCard(props: { botName: string; question: Question }) {
  return <QuestionForm key={props.question.id} {...props} />;
}

function QuestionForm({
  botName,
  question,
}: {
  botName: string;
  question: Question;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [answers, setAnswers] = useState<AnswerState>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const submitting = useRef(false);
  const answer = useMutation({
    retry: false,
    onError: () => { submitting.current = false; },
    mutationFn: (payload: Record<string, string | string[]>) =>
      getBotClient().answerQuestion(question.id, { answers: payload }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(question.threadId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(question.botId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bots() });
    },
  });

  const toggle = (item: QuestionItem, label: string) => {
    if (!item.multiple) setOther((current) => ({ ...current, [item.id]: "" }));
    setAnswers((current) => {
      const existing = current[item.id] ?? [];
      const next = item.multiple
        ? existing.includes(label)
          ? existing.filter((entry) => entry !== label)
          : [...existing, label]
        : existing.includes(label)
          ? []
          : [label];
      return { ...current, [item.id]: next };
    });
  };

  const complete = question.items.every((item) => {
    const chosen = answers[item.id] ?? [];
    return chosen.length > 0 || (other[item.id] ?? "").trim().length > 0;
  });

  const disabled = question.status !== "pending" || answer.isPending || answer.isSuccess;
  const submit = () => {
    if (!complete || disabled || submitting.current) return;
    submitting.current = true;
    const payload: Record<string, string | string[]> = {};
    for (const item of question.items) {
      const chosen = answers[item.id] ?? [];
      const written = item.allowOther ? (other[item.id] ?? "").trim() : "";
      const merged = written ? [...chosen, written] : chosen;
      payload[item.id] = item.multiple ? merged : (merged[0] ?? "");
    }
    answer.mutate(payload);
  };

  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-brand/[0.04] p-3.5">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-brand/15 text-brand">
          <IconMessageQuestion className="size-4" />
        </span>
        <div>
          <p className="font-medium text-[13px]">{t("question.title", { name: botName })}</p>
          <p className="text-[11px] text-muted-foreground">
            {question.items.length === 1
              ? t("question.one")
              : t("question.many", { count: question.items.length })}{" "}
            · {question.status === "expired" ? t("question.expired") : question.status === "answered" || answer.isSuccess ? t("question.answered") : t("question.paused")}
          </p>
        </div>
      </div>
      <Questionnaire
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || answer.isPending) return;
          submit();
        }}
      >
        {question.items.map((item) => (
          <ItemField
            answers={answers[item.id] ?? []}
            disabled={disabled}
            name={`${question.id}:${item.id}`}
            item={item}
            key={item.id}
            onOther={(value) => {
              setOther((current) => ({ ...current, [item.id]: value }));
              if (!item.multiple && value.trim()) setAnswers((current) => ({ ...current, [item.id]: [] }));
            }}
            onToggle={(label) => toggle(item, label)}
            other={other[item.id] ?? ""}
          />
        ))}
        {answer.error ? (
          <p className="text-destructive text-xs" role="alert">
            {answer.error.message}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button
            disabled={!complete || disabled}
            size="sm"
            type="submit"
          >
            {answer.isPending ? t("question.sending") : t("question.submit")}
          </Button>
        </div>
      </Questionnaire>
    </div>
  );
}
