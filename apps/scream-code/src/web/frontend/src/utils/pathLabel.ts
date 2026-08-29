/**
 * Path display helper.
 *
 * CSS `direction: rtl` is the usual trick to keep a filename while clipping a
 * long directory, but it breaks on paths: `/` is a bidi-neutral character, so
 * the browser reorders segments and the ellipsis lands mid-string
 * (`src/web/frontend/src/com…nents/App.vue`). Trimming whole segments here
 * keeps the rendering deterministic and the filename always intact.
 */
export interface PathLabel {
  /** Directory prefix including the trailing `/`; may start with `…/`. */
  dir: string;
  /** Final path segment. */
  base: string;
}

/** Paths at or below this length are shown in full. */
const FULL_PATH_LIMIT = 34;

export function splitPath(path: string): PathLabel {
  const segments = path.split('/');
  const base = segments.at(-1) ?? path;
  if (segments.length <= 2) {
    return { dir: segments.length === 2 ? `${segments[0]}/` : '', base };
  }
  if (path.length <= FULL_PATH_LIMIT) {
    return { dir: `${segments.slice(0, -1).join('/')}/`, base };
  }
  return { dir: `…/${segments.at(-2)}/`, base };
}
