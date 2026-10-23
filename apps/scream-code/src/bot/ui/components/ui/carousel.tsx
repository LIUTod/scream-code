import * as React from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type CarouselApi = {
  canScrollNext: () => boolean;
  canScrollPrev: () => boolean;
  scrollNext: () => void;
  scrollPrev: () => void;
};

type CarouselContextValue = {
  orientation: "horizontal" | "vertical";
  scroller: React.RefObject<HTMLDivElement | null>;
  canScrollNext: boolean;
  canScrollPrev: boolean;
  scrollNext: () => void;
  scrollPrev: () => void;
};

const CarouselContext = React.createContext<CarouselContextValue | null>(null);

function useCarousel(): CarouselContextValue {
  const context = React.useContext(CarouselContext);
  if (!context) {
    throw new Error("useCarousel must be used within a Carousel.");
  }
  return context;
}

function Carousel({
  orientation = "horizontal",
  setApi,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical";
  setApi?: (api: CarouselApi) => void;
}) {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const [canScrollPrev, setCanScrollPrev] = React.useState(false);
  const [canScrollNext, setCanScrollNext] = React.useState(false);

  const measure = React.useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const horizontal = orientation === "horizontal";
    const position = horizontal ? element.scrollLeft : element.scrollTop;
    const size = horizontal ? element.clientWidth : element.clientHeight;
    const total = horizontal ? element.scrollWidth : element.scrollHeight;
    setCanScrollPrev(position > 8);
    setCanScrollNext(position + size < total - 8);
  }, [orientation]);

  const scrollBy = React.useCallback(
    (direction: 1 | -1) => {
      const element = scroller.current;
      if (!element) return;
      const horizontal = orientation === "horizontal";
      element.scrollBy({
        behavior: "smooth",
        left: horizontal ? direction * element.clientWidth : 0,
        top: horizontal ? 0 : direction * element.clientHeight,
      });
    },
    [orientation],
  );

  const scrollPrev = React.useCallback(() => scrollBy(-1), [scrollBy]);
  const scrollNext = React.useCallback(() => scrollBy(1), [scrollBy]);

  React.useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  const api = React.useMemo<CarouselApi>(
    () => ({
      canScrollNext: () => canScrollNext,
      canScrollPrev: () => canScrollPrev,
      scrollNext,
      scrollPrev,
    }),
    [canScrollNext, canScrollPrev, scrollNext, scrollPrev],
  );

  React.useEffect(() => {
    setApi?.(api);
  }, [api, setApi]);

  const value = React.useMemo(
    () => ({
      canScrollNext,
      canScrollPrev,
      orientation,
      scroller,
      scrollNext,
      scrollPrev,
    }),
    [canScrollNext, canScrollPrev, orientation, scrollNext, scrollPrev],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable=true]")) {
      return;
    }
    const previous =
      orientation === "horizontal"
        ? event.key === "ArrowLeft"
        : event.key === "ArrowUp";
    const next =
      orientation === "horizontal"
        ? event.key === "ArrowRight"
        : event.key === "ArrowDown";
    if (!previous && !next) return;
    event.preventDefault();
    if (previous) scrollPrev();
    else scrollNext();
  };

  return (
    <CarouselContext.Provider value={value}>
      <div
        aria-roledescription="carousel"
        className={cn("relative", className)}
        data-slot="carousel"
        onKeyDownCapture={handleKeyDown}
        role="region"
        {...props}
      >
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

function CarouselContent({ className, ...props }: React.ComponentProps<"div">) {
  const { orientation, scroller } = useCarousel();
  return (
    <div
      ref={scroller}
      className={cn(
        "overflow-hidden",
        orientation === "horizontal"
          ? "overflow-x-auto snap-x snap-mandatory"
          : "overflow-y-auto snap-y snap-mandatory",
      )}
      data-slot="carousel-content"
    >
      <div
        className={cn(
          "flex",
          orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CarouselItem({ className, ...props }: React.ComponentProps<"div">) {
  const { orientation } = useCarousel();
  return (
    <div
      aria-roledescription="slide"
      className={cn(
        "min-w-0 shrink-0 grow-0 basis-full snap-start",
        orientation === "horizontal" ? "pl-4" : "pt-4",
        className,
      )}
      data-slot="carousel-item"
      role="group"
      {...props}
    />
  );
}

function CarouselPrevious({
  className,
  variant = "outline",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { canScrollPrev, orientation, scrollPrev } = useCarousel();
  return (
    <Button
      className={cn(
        "absolute touch-manipulation rounded-full",
        orientation === "horizontal"
          ? "inset-y-0 -left-12 my-auto"
          : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
        className,
      )}
      data-slot="carousel-previous"
      disabled={!canScrollPrev}
      onClick={scrollPrev}
      size={size}
      variant={variant}
      {...props}
    >
      <IconChevronLeft />
      <span className="sr-only">Previous slide</span>
    </Button>
  );
}

function CarouselNext({
  className,
  variant = "outline",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { canScrollNext, orientation, scrollNext } = useCarousel();
  return (
    <Button
      className={cn(
        "absolute touch-manipulation rounded-full",
        orientation === "horizontal"
          ? "inset-y-0 -right-12 my-auto"
          : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
        className,
      )}
      data-slot="carousel-next"
      disabled={!canScrollNext}
      onClick={scrollNext}
      size={size}
      variant={variant}
      {...props}
    >
      <IconChevronRight />
      <span className="sr-only">Next slide</span>
    </Button>
  );
}

export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  useCarousel,
};
