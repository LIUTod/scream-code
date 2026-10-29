import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Note: these tests guard the *shape* of the documentation index (every shipped
// doc is listed, every listed doc exists). They cannot check whether a document
// describes the product correctly — that stays a review responsibility.

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const SYSTEM_MD = join(REPO_ROOT, 'packages/agent-core/src/profile/default/system.md');
const DOCS_DIR = join(REPO_ROOT, 'docs');

/** File names listed in the system prompt's "Product Documentation" section. */
function indexedDocs(): string[] {
  const md = readFileSync(SYSTEM_MD, 'utf8');
  const start = md.indexOf('# Product Documentation');
  const end = md.indexOf('# Product Command Index', start);
  if (start === -1 || end === -1) {
    throw new Error('Product Documentation section is missing from system.md');
  }
  const block = md.slice(start, end);
  return [...new Set([...block.matchAll(/`([a-z-]+\.md)`/g)].map((match) => match[1] as string))];
}

describe('product documentation index in the system prompt', () => {
  it('lists at least the core topics', () => {
    expect(indexedDocs().length).toBeGreaterThanOrEqual(5);
  });

  it('only lists documents that exist in docs/', () => {
    const missing = indexedDocs().filter((doc) => !existsSync(join(DOCS_DIR, doc)));

    expect(missing).toEqual([]);
  });

  it('lists every document shipped in docs/', () => {
    const shipped = readdirSync(DOCS_DIR).filter((file) => file.endsWith('.md'));
    const indexed = new Set(indexedDocs());

    expect(shipped.filter((doc) => !indexed.has(doc))).toEqual([]);
  });

  it('tells the model to resolve them from the self-asset map, not the working directory', () => {
    const md = readFileSync(SYSTEM_MD, 'utf8');
    const start = md.indexOf('# Product Documentation');
    const block = md.slice(start, md.indexOf('# Product Command Index', start));

    expect(block).toContain('self-asset map');
    expect(block).toContain('never from the working directory');
  });
});
