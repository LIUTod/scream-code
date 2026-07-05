import { createFastEmbedEngine } from '@scream-code/memory';
import { KnowledgeStore } from '@scream-code/knowledge';

import { getDataDir } from '#/utils/paths';

let knowledgeStoreInstance: KnowledgeStore | undefined;

export async function getKnowledgeStore(): Promise<KnowledgeStore> {
  if (knowledgeStoreInstance === undefined) {
    knowledgeStoreInstance = new KnowledgeStore(getDataDir());
    await knowledgeStoreInstance.init();
    knowledgeStoreInstance.setEmbeddingEngine(createFastEmbedEngine());
  }
  return knowledgeStoreInstance;
}
