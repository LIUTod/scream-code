import { t } from '@scream-code/config';
import type { EmbeddingLoadProgress } from '@scream-code/memory';

/**
 * Spinner label for an in-flight model load: byte progress while downloading
 * ("12.3 MB / 52.9 MB (23%)"), then the verify and load phases.
 *
 * Without a content-length the byte count is still reported, so the number
 * visibly moves on a slow link instead of looking frozen — the failure mode
 * that used to leave users staring at a generic spinner.
 */
export function embeddingProgressLabel(progress: EmbeddingLoadProgress): string {
  if (progress.phase === 'verify') return t('kw.embedding_verifying');
  if (progress.phase === 'load') return t('kw.embedding_loading');
  const done = `${(progress.received / 1048576).toFixed(1)} MB`;
  if (progress.total === undefined) {
    return t('kw.embedding_progress_unknown', { done });
  }
  const total = `${(progress.total / 1048576).toFixed(1)} MB`;
  const percent = Math.min(100, Math.floor((progress.received / progress.total) * 100));
  return t('kw.embedding_progress', { done, total, percent: `${percent}` });
}
