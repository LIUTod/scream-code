import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface MentionCandidate {
  readonly id: string;
  readonly name: string;
  readonly seed: string;
  readonly emoji?: string | null;
  readonly hue?: number | null;
}

/**
 * The list above the composer while an `@` token is active.
 *
 * Keyboard handling stays with the textarea — a listbox that steals focus
 * would drop the caret — so rows only report a mouse pick.
 */
export function MentionPopup({
  activeIndex,
  candidates,
  onPick,
}: {
  activeIndex: number;
  candidates: readonly MentionCandidate[];
  onPick: (candidate: MentionCandidate) => void;
}) {
  const { t } = useI18n();
  if (candidates.length === 0) return null;
  return (
    <div
      aria-label={t("composer.mentionsTitle")}
      className="absolute bottom-full left-0 z-10 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
      id="room-mention-listbox"
      role="listbox"
    >
      <p className="px-2 pt-1 pb-1.5 text-[10.5px] text-muted-foreground uppercase tracking-[0.12em]">
        {t("composer.mentionsTitle")}
      </p>
      {candidates.map((candidate, index) => (
        <button
          aria-selected={index === activeIndex}
          id={`room-mention-${String(index)}`}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
            index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
          )}
          key={candidate.id}
          onMouseDown={(event) => {
            // Keep the textarea's selection: a click that moves focus first
            // would apply the insertion at the wrong caret.
            event.preventDefault();
            onPick(candidate);
          }}
          role="option"
          type="button"
        >
          <AbstractAvatar
            emoji={candidate.emoji}
            hue={candidate.hue}
            name={candidate.name}
            seed={candidate.seed}
            size={22}
          />
          <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
        </button>
      ))}
      <p className="border-t border-border/60 px-2 pt-1.5 pb-1 text-[10.5px] text-muted-foreground">
        {t("composer.mentionsHint")}
      </p>
    </div>
  );
}
