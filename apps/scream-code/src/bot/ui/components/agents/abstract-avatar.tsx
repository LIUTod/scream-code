
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextRandom(state: { value: number }): number {
  // xorshift32: small, deterministic, and good enough for a decorative grid.
  let x = state.value;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.value = x >>> 0;
  return state.value / 0xffffffff;
}

/** The identity hue this seed falls back to when no explicit hue is configured. */
export function hueForSeed(seed: string): number {
  return hashSeed(seed) % 360;
}

export function AbstractAvatar({
  name,
  seed,
  size = 40,
  emoji,
  hue: hueProp,
}: {
  name: string;
  seed: string;
  size?: number;
  emoji?: string | null;
  hue?: number | null;
}) {
  const hash = hashSeed(seed);
  const state = { value: hash || 1 };
  const hue = hueProp ?? hash % 360;
  if (emoji !== undefined && emoji !== null && emoji.length > 0) {
    return (
      <span
        aria-label={name}
        className="avatar-emoji inline-flex shrink-0 items-center justify-center rounded-full ring-1 ring-black/5 dark:ring-white/10"
        role="img"
        style={{ height: size, width: size, ["--avatar-hue" as string]: String(hue) }}
      >
        <span style={{ fontSize: Math.max(10, Math.round(size * 0.5)), lineHeight: 1 }}>{emoji}</span>
      </span>
    );
  }
  const palette = [
    `hsl(${hue} 58% 88%)`,
    `hsl(${(hue + 28) % 360} 52% 58%)`,
    `hsl(${(hue + 210) % 360} 45% 34%)`,
  ];
  const cells: { x: number; y: number; color: string }[] = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const roll = nextRandom(state);
      if (roll < 0.45) continue;
      const color = palette[Math.floor(roll * 10) % palette.length] ?? palette[0];
      cells.push({ color: color ?? palette[0] ?? "#888", x, y });
      if (x < 2) cells.push({ color: color ?? palette[0] ?? "#888", x: 4 - x, y });
    }
  }

  return (
    <span
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-black/5 dark:ring-white/10"
      role="img"
      style={{ height: size, width: size }}
    >
      <svg
        aria-hidden="true"
        height={size}
        viewBox="0 0 5 5"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect fill={palette[0]} height="5" width="5" />
        {cells.map((cell, index) => (
          <rect
            fill={cell.color}
            height="1"
            key={`${cell.x}-${cell.y}-${index}`}
            width="1"
            x={cell.x}
            y={cell.y}
          />
        ))}
      </svg>
    </span>
  );
}
