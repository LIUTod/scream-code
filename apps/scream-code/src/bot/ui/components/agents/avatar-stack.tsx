import type { CSSProperties } from "react";

import { AbstractAvatar } from "@/components/agents/abstract-avatar";

/**
 * Two or three faces in one slot.
 *
 * Overlap alone leaves the seam visible on every background, so each face is
 * masked with a cut-out where the next one sits: the stack reads as one object
 * whether it is on a hovered row, a selected row, or dark.
 */
const LAYOUTS: Record<number, readonly (readonly [number, number])[]> = {
  2: [
    [0, 0],
    [0.32, 0.32],
  ],
  3: [
    [0.22, 0],
    [0, 0.44],
    [0.44, 0.44],
  ],
};

export function AvatarStack({
  people,
  size = 32,
}: {
  people: readonly {
    readonly name: string;
    readonly seed: string;
    readonly emoji?: string | null;
    readonly hue?: number | null;
  }[];
  size?: number;
}) {
  const shown = people.slice(0, 3);
  if (shown.length === 0) return null;
  const [first] = shown;
  if (first === undefined) return null;
  if (shown.length === 1) {
    return (
      <AbstractAvatar
        emoji={first.emoji}
        hue={first.hue}
        name={first.name}
        seed={first.seed}
        size={size}
      />
    );
  }
  const layout = LAYOUTS[shown.length] ?? LAYOUTS[2]!;
  const diameter = size * (shown.length === 2 ? 0.68 : 0.56);
  const gap = Math.max(1, size * 0.05);
  return (
    <span
      aria-hidden="true"
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {shown.map((person, index) => {
        const [x, y] = layout[index] ?? [0, 0];
        const cuts = layout.slice(index + 1).map(([nx, ny]) => {
          const cx = (nx - x) * size + diameter / 2;
          const cy = (ny - y) * size + diameter / 2;
          const edge = diameter / 2 + gap;
          return `radial-gradient(circle at ${cx}px ${cy}px, transparent ${edge}px, #000 ${edge + 0.5}px)`;
        });
        const style: CSSProperties = {
          position: "absolute",
          left: x * size,
          top: y * size,
          width: diameter,
          height: diameter,
          ...(cuts.length > 0
            ? {
                WebkitMaskImage: cuts.join(", "),
                maskImage: cuts.join(", "),
                WebkitMaskComposite: "source-in",
                maskComposite: "intersect",
              }
            : {}),
        };
        return (
          <span key={`${person.seed}-${String(index)}`} style={style}>
            <AbstractAvatar
              emoji={person.emoji}
              hue={person.hue}
              name={person.name}
              seed={person.seed}
              size={diameter}
            />
          </span>
        );
      })}
    </span>
  );
}
