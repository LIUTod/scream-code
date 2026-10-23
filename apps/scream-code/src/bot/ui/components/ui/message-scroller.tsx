import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type MessageScrollerContextValue = {
  atEnd: boolean;
  atStart: boolean;
  scrollToEnd: (behavior?: ScrollBehavior) => void;
  scrollToStart: (behavior?: ScrollBehavior) => void;
};

const MessageScrollerContext =
  createContext<MessageScrollerContextValue | null>(null);

function useMessageScroller(): MessageScrollerContextValue {
  const context = useContext(MessageScrollerContext);
  if (!context) {
    throw new Error("useMessageScroller must be used within a MessageScroller.");
  }
  return context;
}

export function useMessageScrollerScrollable() {
  const { atEnd, atStart } = useMessageScroller();
  return { start: !atStart, end: !atEnd };
}

function MessageScrollerProvider({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [atStart, setAtStart] = useState(true);
  // Whether the next content change should drag the viewport down with it.
  const stick = useRef(true);

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const end = distance < 24;
    stick.current = end;
    setAtEnd(end);
    setAtStart(element.scrollTop < 24);
  }, []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({ behavior, top: element.scrollHeight });
    stick.current = true;
  }, []);

  const scrollToStart = useCallback((behavior: ScrollBehavior = "smooth") => {
    viewport.current?.scrollTo({ behavior, top: 0 });
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) {
        element.scrollTop = element.scrollHeight;
      }
      measure();
    });
    observer.observe(element);
    for (const child of element.children) {
      observer.observe(child);
    }
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [measure]);

  const value = useMemo(
    () => ({ atEnd, atStart, scrollToEnd, scrollToStart }),
    [atEnd, atStart, scrollToEnd, scrollToStart],
  );

  return (
    <MessageScrollerContext.Provider value={value}>
      <ViewportRef.Provider value={viewport}>{children}</ViewportRef.Provider>
    </MessageScrollerContext.Provider>
  );
}

const ViewportRef = createContext<React.RefObject<HTMLDivElement | null> | null>(
  null,
);

function MessageScroller({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const ref = useContext(ViewportRef);
  return (
    <div
      ref={ref}
      data-slot="message-scroller-viewport"
      tabIndex={0}
      className={cn(
        "size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain",
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-item"
      className={cn("min-w-0 shrink-0", className)}
      {...props}
    />
  );
}

function MessageScrollerButton({
  className,
  direction = "end",
  children,
  ...props
}: React.ComponentProps<"button"> & { direction?: "start" | "end" }) {
  const { t } = useI18n();
  const { atEnd, atStart, scrollToEnd, scrollToStart } = useMessageScroller();
  const active = direction === "end" ? !atEnd : !atStart;
  return (
    <button
      type="button"
      data-slot="message-scroller-button"
      data-active={active}
      className={cn(
        "absolute inset-x-0 mx-auto z-10 grid size-7 place-items-center rounded-full border border-border bg-background text-foreground shadow-sm transition-[translate,scale,opacity] duration-200",
        "data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0",
        direction === "end" ? "bottom-4" : "top-4",
        className,
      )}
      onClick={() => {
        if (direction === "end") scrollToEnd();
        else scrollToStart();
      }}
      {...props}
    >
      {children ?? (
        <span aria-hidden className="text-xs">
          {direction === "end" ? "↓" : "↑"}
        </span>
      )}
      <span className="sr-only">
        {direction === "end" ? t("transcript.scrollEnd") : t("transcript.scrollStart")}
      </span>
    </button>
  );
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
};
