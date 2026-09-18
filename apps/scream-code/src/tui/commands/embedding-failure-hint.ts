import { t } from '@scream-code/config';
import type { EmbeddingFailureKind } from '@scream-code/memory';

/**
 * The line shown above the raw error in a failed embedding download.
 *
 * Every cause used to share one hint that blamed the network and suggested a
 * proxy, which is wrong for a machine that simply has no local model binary —
 * that single sentence is what made four different failures look like the same
 * connectivity complaint. Kept apart from the store so the copy can be read and
 * tested on its own.
 */
export function embeddingFailureHint(kind: EmbeddingFailureKind | undefined): string {
  switch (kind) {
    case 'platform':
      return t('knowledge.embedding_platform_hint');
    case 'archive':
      return t('knowledge.embedding_cache_corrupt_hint');
    case 'network':
      return t('knowledge.embedding_network_hint');
    default:
      return t('knowledge.embedding_unknown_hint');
  }
}

/**
 * The detail block a failure notice shows: the hint, then the first line of the
 * raw error.
 *
 * Only the first line is displayed — Node appends a "Require stack:" block to
 * module errors, a local path dump no user needs (and the line we ask people to
 * send us) — while the engine keeps the full text for diagnosis.
 */
export function embeddingFailureDetail(
  kind: EmbeddingFailureKind | undefined,
  error: string | undefined,
): string {
  return [embeddingFailureHint(kind), error?.split('\n')[0]].filter(Boolean).join('\n');
}
