/**
 * Extension-based dispatch for the right-hand file panel (pure functions,
 * unit-tested in isolation). Decides how a file renders in preview mode and
 * which syntax-highlighting language hint to hand the code block.
 */

export type FilePreviewKind = 'image' | 'audio' | 'markdown' | 'pdf' | 'source';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg']);
const MARKDOWN_EXTS = new Set(['md', 'markdown']);

/** Lower-cased extension of the path's basename ('' when none). */
export function extOfPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  // Dotfiles like `.env` carry no extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Which preview renderer a file type maps to; anything unknown falls back to source. */
export function previewKindForPath(path: string): FilePreviewKind {
  const ext = extOfPath(path);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  // PDFs render inline in the browser via an iframe against the raw endpoint.
  if (ext === 'pdf') return 'pdf';
  return 'source';
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'toml', ini: 'ini', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', less: 'less', sql: 'sql', md: 'markdown',
  markdown: 'markdown', vue: 'vue', svelte: 'svelte', swift: 'swift', kt: 'kotlin',
  lua: 'lua', r: 'r', dart: 'dart', graphql: 'graphql', proto: 'protobuf', txt: 'text',
};

/** Language hint for the code viewer, derived from the extension (falls back to plain text). */
export function languageForPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (name === 'dockerfile') return 'docker';
  if (name === 'makefile') return 'make';
  return LANG_BY_EXT[extOfPath(path)] ?? 'text';
}
