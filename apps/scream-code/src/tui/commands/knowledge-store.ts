import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createFastEmbedEngine } from '@scream-code/memory';
import { KnowledgeStore } from '@scream-code/knowledge';

import { getDataDir } from '#/utils/paths';

let knowledgeStoreInstance: KnowledgeStore | undefined;

function getEmbeddingCacheDir(): string {
  const dir = join(getDataDir(), 'cache', 'fastembed');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function getKnowledgeStore(): Promise<KnowledgeStore> {
  if (knowledgeStoreInstance === undefined) {
    knowledgeStoreInstance = new KnowledgeStore(getDataDir());
    await knowledgeStoreInstance.init();
    knowledgeStoreInstance.setEmbeddingEngine(createFastEmbedEngine(getEmbeddingCacheDir()));
  }
  return knowledgeStoreInstance;
}
