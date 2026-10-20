// turndown-plugin-gfm ships no types; declare the single `gfm` export.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
}
