import type * as React from "react";
import { IconCheck } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function Questionnaire({ className, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      data-slot="questionnaire"
      className={cn("flex w-full min-w-0 flex-col gap-4", className)}
      {...props}
    />
  );
}

function QuestionnaireItem({
  className,
  ...props
}: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="questionnaire-item"
      className={cn(
        "flex min-w-0 flex-col gap-3 border-0 p-0 outline-none",
        className,
      )}
      {...props}
    />
  );
}

function QuestionnaireTitle({
  className,
  ...props
}: React.ComponentProps<"legend">) {
  return (
    <legend
      data-slot="questionnaire-title"
      className={cn(
        "font-heading text-base leading-snug font-medium text-pretty",
        className,
      )}
      {...props}
    />
  );
}

function QuestionnaireDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="questionnaire-description"
      className={cn("text-pretty text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function QuestionnaireProgress({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="questionnaire-progress"
      className={cn(
        "min-h-[1lh] w-fit min-w-[10ch] font-medium text-muted-foreground text-xs tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function QuestionnaireChoices({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="questionnaire-choices"
      className={cn("grid min-w-0 gap-2", className)}
      {...props}
    />
  );
}

function QuestionnaireChoice({
  className,
  type = "radio",
  checked,
  disabled,
  name,
  onChange,
  value,
  children,
  ...props
}: React.ComponentProps<"label"> & {
  type?: "radio" | "checkbox";
  checked?: boolean;
  disabled?: boolean;
  name?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  value?: string;
}) {
  return (
    <label
      data-slot="questionnaire-choice"
      className={cn(
        "group/questionnaire-choice relative flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-input bg-transparent px-3 py-2.5 text-start text-sm transition-colors select-none",
        "hover:bg-muted/50 has-[>input:focus-visible]:border-ring has-[>input:focus-visible]:ring-3 has-[>input:focus-visible]:ring-ring/50",
        "has-[>input:checked]:border-primary/40 has-[>input:checked]:bg-muted",
        className,
      )}
      {...props}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        name={name}
        onChange={onChange}
        type={type}
        value={value}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none relative mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input bg-transparent",
          type === "radio" ? "rounded-full" : "rounded-[4px]",
          "group-has-[>input:checked]/questionnaire-choice:border-primary group-has-[>input:checked]/questionnaire-choice:bg-primary group-has-[>input:checked]/questionnaire-choice:text-primary-foreground",
        )}
      >
        <IconCheck className="hidden size-3 group-has-[>input:checked]/questionnaire-choice:block" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        {children}
      </span>
    </label>
  );
}

function QuestionnaireChoiceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="questionnaire-choice-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

function QuestionnaireInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="questionnaire-input"
      className={cn(
        "h-8 min-h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-[color,box-shadow,background-color] outline-none sm:min-h-0 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        "placeholder:text-muted-foreground dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

function QuestionnaireError({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="questionnaire-error"
      className={cn("mt-2 text-destructive text-sm", className)}
      {...props}
    />
  );
}

function QuestionnaireActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="questionnaire-actions"
      className={cn(
        "grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 sm:min-h-8",
        className,
      )}
      {...props}
    />
  );
}

function QuestionnaireButton({
  className,
  size = "default",
  variant = "outline",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button className={className} size={size} variant={variant} {...props} />
  );
}

function QuestionnairePrevious({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <QuestionnaireButton
      className={cn("col-start-1 row-start-1 justify-self-start", className)}
      {...props}
    >
      Previous
    </QuestionnaireButton>
  );
}

function QuestionnaireNext({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <QuestionnaireButton
      className={cn("col-start-2 row-start-1", className)}
      variant="default"
      {...props}
    >
      Next
    </QuestionnaireButton>
  );
}

function QuestionnaireSkip({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <QuestionnaireButton
      className={cn("col-start-1 row-start-1 justify-self-start", className)}
      variant="ghost"
      {...props}
    >
      Skip
    </QuestionnaireButton>
  );
}

function QuestionnaireSubmit({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(
        "col-start-3 row-start-1 min-h-11 justify-self-end sm:min-h-0",
        className,
      )}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      Submit
    </Button>
  );
}

export {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
};
