import { describe, expect, it } from 'vitest';
import { DraftStore, canSubmitDraft, draftKey } from '../../../src/bot/ui/lib/draft';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe('per-thread editable drafts, not a client execution queue', () => {
  it('success only releases its own request, never new words', () => {
    const drafts = new DraftStore(() => storage());
    const key = draftKey('a', 'one');
    drafts.edit(key, 'first');
    const request = drafts.begin('a', 'one', 'first', false)!;
    drafts.edit(key, 'second');
    drafts.finish(request);
    expect(drafts.get(key)).toMatchObject({ value: 'second', pending: null, error: null });
    drafts.edit(key, 'third');
    const newer = drafts.begin('a', 'one', 'third', false)!;
    drafts.finish(request, 'late error');
    expect(drafts.get(key).pending).toBe(newer);
    expect(drafts.get(key).value).toBe('');
  });
  it('retains failed words separately from new words and requires an explicit retry', () => {
    const drafts = new DraftStore();
    const key = draftKey('a', 'one');
    drafts.edit(key, ' first\nline ');
    const request = drafts.begin('a', 'one', ' first\nline ', false)!;
    drafts.edit(key, 'new');
    drafts.finish(request, 'offline');
    expect(drafts.get(key)).toMatchObject({ value: 'new', pending: null, error: 'offline', recovered: false, retry: request });
    expect(drafts.get(key).retry?.restore).toBe(' first\nline ');
    expect(drafts.begin('a', 'one', 'new', false)).toBeNull();
  });
  it('keys bot and thread separately, including ambiguous delimiter ids', () => {
    expect(draftKey('a:b', 'c')).not.toBe(draftKey('a', 'b:c'));
    const drafts = new DraftStore();
    drafts.edit(draftKey('a', 'same'), 'A');
    drafts.edit(draftKey('b', 'same'), 'B');
    const pendingA = drafts.begin('a', 'same', 'A', false)!;
    drafts.finish(pendingA, 'A failed');
    expect(drafts.get(draftKey('b', 'same')).value).toBe('B');
  });
  it('persists per-tab drafts and restores uncertain requests as editable words, not queued work', () => {
    const saved = storage();
    const firstMount = new DraftStore(() => saved);
    const key = draftKey('a', 'one');
    firstMount.edit(key, 'original');
    firstMount.begin('a', 'one', 'original', false);
    firstMount.edit(key, 'newer');
    const reload = new DraftStore(() => saved);
    expect(reload.get(key)).toMatchObject({ value: 'newer', pending: null, error: null, recovered: true, retry: { text: 'original', restore: 'original' } });
    expect(reload.get(draftKey('b', 'one')).value).toBe('');
  });
  it('never consumes newer editor text from a stale submit snapshot', () => {
    const drafts = new DraftStore();
    const key = draftKey('a', 'one');
    drafts.edit(key, 'older');
    drafts.edit(key, 'newer');
    const request = drafts.begin('a', 'one', 'older', false)!;
    expect(drafts.get(key).value).toBe('newer');
    drafts.finish(request, 'offline');
    expect(drafts.get(key).value).toBe('newer');
    expect(drafts.get(key).retry?.restore).toBe('older');
  });
  it('does not duplicate a successful suggestion or discard the unsent editor', () => {
    const drafts = new DraftStore();
    const key = draftKey('a', 'one');
    drafts.edit(key, 'unsent');
    const request = drafts.begin('a', 'one', 'suggestion', false, 'queue', false)!;
    drafts.finish(request);
    expect(drafts.get(key).value).toBe('unsent');
  });
  it('blocks synchronous double submit and unifies whitespace/paused guards', () => {
    const drafts = new DraftStore();
    drafts.edit(draftKey('a', 'one'), 'first');
    expect(drafts.begin('a', 'one', 'first', true)).toBeNull();
    expect(drafts.begin('a', 'one', '  \n', false)).toBeNull();
    expect(drafts.begin('a', 'one', 'first', false)).not.toBeNull();
    expect(drafts.begin('a', 'one', 'first', false)).toBeNull();
    expect(canSubmitDraft('x', true, false)).toBe(false);
    expect(canSubmitDraft('x', false, true)).toBe(false);
    expect(canSubmitDraft('', false, false)).toBe(false);
  });
  it('reuses the request key for an unchanged explicit retry, but not attempt ownership', () => {
    const saved = storage();
    const drafts = new DraftStore(() => saved);
    const key = draftKey('a', 'one');
    drafts.edit(key, 'first');
    const original = drafts.begin('a', 'one', 'first', false, 'steer')!;
    drafts.finish(original, 'response lost');
    const retry = drafts.retry('a', 'one', false)!;
    expect(retry.id).toBe(original.id);
    drafts.finish(original); // A stale callback cannot release the current attempt.
    expect(drafts.get(key).pending).toBe(retry);
    const reload = new DraftStore(() => saved);
    expect(reload.retry('a', 'one', false)?.id).toBe(original.id);
    drafts.finish(retry, 'offline');
    drafts.edit(key, 'edited');
    expect(drafts.begin('a', 'one', 'edited', false, 'steer')).toBeNull();
    const confirmed = drafts.retry('a', 'one', false)!;
    drafts.finish(confirmed);
    expect(drafts.get(key).value).toBe('edited');
    expect(drafts.begin('a', 'one', 'edited', false, 'steer')?.id).not.toBe(original.id);
  });
  it('continues working with denied persistence', () => {
    const drafts = new DraftStore(() => { throw new Error('blocked'); });
    const key = draftKey('a', 'one');
    drafts.edit(key, 'hello');
    const request = drafts.begin('a', 'one', 'hello', false)!;
    drafts.finish(request, 'offline');
    expect(drafts.get(key).retry?.restore).toBe('hello');
  });
});
