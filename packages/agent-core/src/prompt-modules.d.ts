// Raw-string imports for prompt sources. The `raw-text-plugin` (used by both
// tsdown and vitest) loads `.md` / `.yaml` files as their string content.

declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.yaml' {
  const content: string;
  export default content;
}
