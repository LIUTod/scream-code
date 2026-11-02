import { dirname, join } from 'pathe';

import type { Jian } from '@scream-code/jian';

import { listDirectory } from '../tools/support/list-directory';
import { resolveScreamHome } from '../config/path';
import type { SystemPromptContext } from './types';

const AGENTS_MD_MAX_BYTES = 32 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export type PreparedSystemPromptContext = Pick<
  SystemPromptContext,
  'cwdListing' | 'agentsMd' | 'roleAdditional'
>;
export async function prepareSystemPromptContext(
  jian: Jian,
): Promise<PreparedSystemPromptContext> {
  const [cwdListing, agentsMd, roleAdditional] = await Promise.all([
    listDirectory(jian),
    loadAgentsMd(jian),
    loadRoleAdditional(jian),
  ]);
  return { cwdListing, agentsMd, roleAdditional };
}

export async function loadRoleAdditional(_jian: Jian): Promise<string | undefined> {
  const prefsPath = join(resolveScreamHome(), 'user-prefs.md');
  if (!(await pathExists(_jian, prefsPath))) {
    return undefined;
  }
  try {
    const content = await _jian.readText(prefsPath);
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function loadAgentsMd(jian: Jian): Promise<string> {
  const workDir = jian.getcwd();
  const projectRoot = await findProjectRoot(jian, workDir);
  const dirs = dirsRootToLeaf(jian, workDir, projectRoot);
  const discovered: AgentFile[] = [];
  const seen = new Set<string>();

  const collect = async (path: string): Promise<boolean> => {
    const file = await readAgentFile(jian, path);
    if (file === undefined) return false;
    const key = jian.normpath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    discovered.push(file);
    return true;
  };

  // User-level files come first so any project-level AGENTS.md overrides them.
  const home = jian.gethome();
  await collect(join(home, '.scream-code', 'AGENTS.md'));

  // Generic user-level dir (.agents) matches skill discovery.
  const genericDirs = [join(home, '.agents')];
  const genericFiles = genericDirs.flatMap((dir) =>
    ['AGENTS.md', 'agents.md'].map((name) => join(dir, name)),
  );
  for (const file of genericFiles) {
    if (await collect(file)) break;
  }

  for (const dir of dirs) {
    await collect(join(dir, '.scream-code', 'AGENTS.md'));
    for (const fileName of ['AGENTS.md', 'agents.md']) {
      if (await collect(join(dir, fileName))) break;
    }
  }

  return renderAgentFiles(discovered);
}

async function findProjectRoot(jian: Jian, workDir: string): Promise<string> {
  const initial = jian.normpath(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(jian, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dirsRootToLeaf(jian: Jian, workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = jian.normpath(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

async function readAgentFile(jian: Jian, path: string): Promise<AgentFile | undefined> {
  if (!(await isFile(jian, path))) return undefined;
  const content = (await jian.readText(path, { errors: 'ignore' })).trim();
  if (content.length === 0) return undefined;
  return { path, content };
}

async function pathExists(jian: Jian, path: string): Promise<boolean> {
  try {
    await jian.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(jian: Jian, path: string): Promise<boolean> {
  try {
    const stat = await jian.stat(path);
    return (stat.stMode & S_IFMT) === S_IFREG;
  } catch {
    return false;
  }
}

/**
 * Per-file floor: every discovered AGENTS.md keeps at least this much content
 * before a larger file may take the rest of the budget.
 *
 * Without it, a huge project file consumed the whole budget and every shallower
 * file was dropped outright — a 148 KB `AGENTS.md` silently erased the user-level
 * `~/.scream-code/AGENTS.md` conventions from the prompt. Deeper files still
 * override shallower ones; they no longer delete them.
 */
const AGENTS_MD_MIN_BYTES = 2 * 1024;

/** Tells the model what it did not get, and where to read it, instead of cutting silently. */
function truncationMarker(omittedBytes: number, path: string): string {
  return `\n\n[... ${omittedBytes} bytes truncated; read ${path} for the rest]`;
}

function omissionMarker(path: string): string {
  return `\n\n[... ${path} omitted: the AGENTS.md budget is full; read the file directly]`;
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';

  const frames = files.map((file, index) => ({
    annotation: annotationFor(file.path),
    separator: index < files.length - 1 ? '\n\n' : '',
    size: byteLength(file.content),
  }));
  const framed = files.map(() => false);
  const allocation = files.map(() => 0);
  let remaining = AGENTS_MD_MAX_BYTES;

  /** Charge this file's annotation the first time it is paid for, then hand it bytes. */
  const take = (index: number, want: number): number => {
    if (want <= 0) return 0;
    const frame = frames[index]!;
    const frameCost = framed[index] === true ? 0 : byteLength(frame.annotation) + byteLength(frame.separator);
    const available = remaining - frameCost;
    if (available <= 0) return 0;
    const give = Math.min(want, available);
    remaining -= frameCost + give;
    framed[index] = true;
    return give;
  };

  // Deepest first on both passes: a deeper file overrides its ancestors, so it
  // gets the floor and then the remainder before they do.
  for (let index = files.length - 1; index >= 0; index--) {
    allocation[index] = take(index, Math.min(frames[index]!.size, AGENTS_MD_MIN_BYTES));
  }
  for (let index = files.length - 1; index >= 0; index--) {
    allocation[index] = allocation[index]! + take(index, frames[index]!.size - allocation[index]!);
  }

  const rendered = files.map((file, index) => {
    const given = allocation[index]!;
    if (given === 0) {
      // Nothing left even for a marker we could not pay for: skip silently
      // rather than emit a frame with no content.
      const marker = omissionMarker(file.path);
      const cost = byteLength(frames[index]!.annotation) + byteLength(marker) + byteLength(frames[index]!.separator);
      if (remaining < cost) return '';
      take(index, byteLength(marker));
      return `${frames[index]!.annotation}${marker.slice(2)}`;
    }
    if (given >= frames[index]!.size) {
      return `${frames[index]!.annotation}${file.content}`;
    }
    // Reserve the marker out of this file's own allocation, so the block stays
    // inside the budget and the model is told where the rest lives.
    const estimated = truncationMarker(frames[index]!.size - given, file.path);
    const kept = truncateUtf8(file.content, Math.max(0, given - byteLength(estimated))).trim();
    const marker = truncationMarker(frames[index]!.size - byteLength(kept), file.path);
    return `${frames[index]!.annotation}${kept}${marker}`;
  });

  return rendered.filter((block) => block.length > 0).join('\n\n');
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes on a character boundary.
 *
 * One encode, one boundary walk. Dropping characters one at a time and
 * re-measuring the whole string is quadratic, and it runs on the prompt path of
 * every agent start and every subagent spawn: a 148 KB AGENTS.md against the
 * 32 KB budget did ~115k full-string `byteLength()` passes and blocked the event
 * loop for ~5s before this.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;

  const bytes = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, bytes.length);
  // A continuation byte (0b10xxxxxx) belongs to the character that starts
  // before it, so back up until the cut lands on a lead byte.
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.toString('utf8', 0, end);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}


