import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  ingestDirectory,
  ingestFile,
  isSupportedFile,
  multiSearch,
  type IngestProgress,
  type LlmCaller,
  type KnowledgeSource,
} from '@scream-code/knowledge';
import { t } from '@scream-code/config';

import type { SlashCommandHost } from './dispatch';
import { handleWeb } from './knowledge-web';
import { getKnowledgeStore, getEmbeddingStatus, startManualEmbeddingDownload, isEmbeddingModelCached, type EmbeddingStatus } from './knowledge-store';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { KnowledgeResultViewer } from '../components/dialogs/knowledge-result-viewer';
import {
  KnowledgeDocumentTree,
  type KnowledgeDocumentTreeEntry,
} from '../components/dialogs/knowledge-document-tree';

function promptTextInput(
  host: SlashCommandHost,
  title: string,
  opts?: { subtitle?: string; placeholder?: string; initialValue?: string; allowEmpty?: boolean },
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const dialog = new TextInputDialogComponent(
    (result) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    },
    {
      title,
      subtitle: opts?.subtitle,
      placeholder: opts?.placeholder,
      initialValue: opts?.initialValue,
      allowEmpty: opts?.allowEmpty,
      colors: host.state.theme.colors,
    },
  );
  host.mountEditorReplacement(dialog);
  return promise;
}

function showResultViewer(host: SlashCommandHost, title: string, content: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const viewer = new KnowledgeResultViewer(
    {
      title,
      content,
      colors: host.state.theme.colors,
      onClose: () => {
        host.restoreEditor();
        resolve();
      },
    },
    host.state.terminal,
  );
  host.mountEditorReplacement(viewer);
  return promise;
}

function makeLlmCaller(host: SlashCommandHost): LlmCaller {
  const session = host.session;
  return {
    generate: async (systemPrompt: string, userPrompt: string): Promise<string> => {
      if (session === undefined) throw new Error('no active session');
      return session.generateText(systemPrompt, userPrompt);
    },
  };
}

function formatProgress(progress: IngestProgress): string {
  switch (progress.stage) {
    case 'embedding-check':
      return progress.message;
    case 'chunking':
      return t('knowledge.chunking');
    case 'embedding-chunks':
      return t('knowledge.embedding_chunks', { index: String(progress.chunkIndex), total: String(progress.totalChunks) });
    case 'extracting':
      return t('knowledge.extracting', { index: String(progress.chunkIndex), total: String(progress.totalChunks) });
    case 'embedding-events':
      return t('knowledge.embedding_events', { index: String(progress.chunkIndex), total: String(progress.totalChunks) });
    case 'embedding-entities':
      return t('knowledge.embedding_entities');
    case 'embedding-relations':
      return t('knowledge.embedding_relations');
    case 'completed':
      return progress.message;
    case 'error':
      return t('knowledge.error', { msg: progress.message });
  }
}

async function handleIngest(host: SlashCommandHost): Promise<void> {
  const filePath = await promptTextInput(host, t('knowledge.ingest'), {
    subtitle: t('knowledge.ingest_desc'),
    placeholder: t('knowledge.path_placeholder'),
    allowEmpty: false,
  });
  if (filePath === undefined) return;
  if (filePath.trim().length === 0) {
    host.showError(t('error.path_empty'));
    return;
  }

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    host.showError(t('error.path_not_exist', { path: filePath }));
    return;
  }

  const store = await getKnowledgeStore();
  const llm = makeLlmCaller(host);

  // Embedding readiness gate — never fall back to a silent no-vector ingest.
  // If the model is cached, load it (local files, no network); if it is not
  // downloaded at all, stop and guide the user to the download menu item.
  if (!(await ensureEmbeddingReadyInteractive(host))) return;

  const spinner = host.showProgressSpinner(t('knowledge.ingesting'));
  try {
    if (stats.isDirectory()) {
      const result = await ingestDirectory(store, llm, filePath, (progress) => {
        spinner.setLabel(formatProgress(progress));
      });
      spinner.stop({ ok: result.failed === 0, label: t('knowledge.batch_done') });
      const coverage = await store.embeddingCoverage();
      if (result.failed > 0) {
        const summary = [
          t('knowledge.succeeded', { count: String(result.succeeded) }),
          t('knowledge.failed', { count: String(result.failed) }),
          t('knowledge.ingest_summary', { chunks: String(result.totalChunks), events: String(result.totalEvents), entities: String(result.totalEntities) }),
          t('knowledge.vector_coverage', { embedded: String(coverage.embedded), total: String(coverage.total) }),
          '',
          t('knowledge.failed_files'),
          ...result.errors.map((e) => `  • ${basename(e.filePath)}: ${e.message}`),
        ].join('\n');
        host.showNotice(t('knowledge.batch_partial'), summary);
      } else {
        host.showNotice(
          t('knowledge.batch_done'),
          `${t('knowledge.succeeded', { count: String(result.succeeded) })}\n${result.totalChunks} chunks, ${result.totalEvents} events, ${result.totalEntities} entities\n${t('knowledge.vector_coverage', { embedded: String(coverage.embedded), total: String(coverage.total) })}`,
        );
      }
    } else {
      if (!isSupportedFile(filePath)) {
        spinner.stop({ ok: false, label: t('error.unsupported_format') });
        host.showError(t('error.unsupported_format'));
        return;
      }
      const result = await ingestFile(store, llm, filePath, (progress) => {
        spinner.setLabel(formatProgress(progress));
      });
      spinner.stop({ ok: true, label: t('knowledge.ingest_done') });
      const coverage = await store.embeddingCoverage();
      host.showNotice(
        t('knowledge.ingest_done'),
        `${t('knowledge.file_label')}: ${basename(filePath)}\nchunks: ${result.chunkCount}\nevents: ${result.eventCount}\nentities: ${result.entityCount}\n${t('knowledge.vector_coverage', { embedded: String(coverage.embedded), total: String(coverage.total) })}`,
      );
    }
  } catch (error) {
    spinner.stop({ ok: false, label: t('knowledge.ingest_fail') });
    throw error;
  }
}

/**
 * Ensure the shared embedding engine is ready before a vector-dependent
 * operation. Returns true when ready; otherwise shows an error (missing
 * download) or attempts a cached-model load and reports the outcome.
 */
async function ensureEmbeddingReadyInteractive(host: SlashCommandHost): Promise<boolean> {
  const store = await getKnowledgeStore();
  const engine = store.getEmbeddingEngine();
  if (engine !== undefined && engine.available) return true;

  if (!isEmbeddingModelCached()) {
    host.showError(t('knowledge.model_missing'));
    return false;
  }
  const spinner = host.showProgressSpinner(t('knowledge.loading_model'));
  const { ok, error } = await startManualEmbeddingDownload();
  spinner.stop({ ok, label: ok ? t('kw.embedding_ready') : t('kw.embedding_failed') });
  if (!ok) {
    const detail = [t('knowledge.download_model_retry_hint'), error].filter(Boolean).join('\n');
    host.showNotice(t('knowledge.model_load_failed'), detail);
    return false;
  }
  return true;
}

async function handleList(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const docs = await store.listDocuments();
  const entries: KnowledgeDocumentTreeEntry[] = [];
  for (const doc of docs) {
    const chunks = await store.listChunksByDocument(doc.id);
    const source = await store.getSource(doc.sourceId);
    if (source === undefined) continue;
    entries.push({ source, document: doc, chunks });
  }

  if (entries.length === 0) {
    await showResultViewer(host, t('knowledge.docs_title'), t('knowledge.empty'));
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  const tree = new KnowledgeDocumentTree(
    {
      title: t('knowledge.docs_title'),
      entries,
      colors: host.state.theme.colors,
      onClose: () => {
        host.restoreEditor();
        resolve();
      },
    },
    host.state.terminal,
  );
  host.mountEditorReplacement(tree);
  await promise;
}

async function handleSearch(host: SlashCommandHost): Promise<void> {
  const query = await promptTextInput(host, t('knowledge.search'), {
    subtitle: t('knowledge.search_desc'),
    placeholder: t('knowledge.search_placeholder'),
    allowEmpty: false,
  });
  if (query === undefined || query.trim().length === 0) return;

  const store = await getKnowledgeStore();
  const llm = makeLlmCaller(host);
  const spinner = host.showProgressSpinner(t('knowledge.searching'));
  let results;
  try {
    results = await multiSearch(store, llm, query, { topK: 5 });
  } catch (error) {
    spinner.stop({ ok: false, label: t('knowledge.search_fail') });
    throw error;
  }
  spinner.stop({ ok: true, label: t('knowledge.search_done') });

  const engine = store.getEmbeddingEngine();
  const degraded = engine === undefined || !engine.available;

  if (results.length === 0) {
    await showResultViewer(host, t('knowledge.search_result'), `${t('knowledge.no_hits', { query })}${degraded ? '\n\n⚠️ ' + t('knowledge.vector_degraded') : ''}`);
    return;
  }

  const lines: string[] = [`${t('knowledge.query_label')}: ${query}`, ''];
  if (degraded) {
    lines.push('⚠️ ' + t('knowledge.vector_degraded'));
    lines.push('');
  }
  for (const [i, r] of results.entries()) {
    lines.push(`#${i + 1} [score=${r.score.toFixed(3)}] ${r.heading ?? t('knowledge.no_title')}`);
    lines.push(`   ${t('knowledge.source_label')}: ${r.sourceName}`);
    lines.push(`   ${r.content}`);
    lines.push('');
  }
  await showResultViewer(host, `${t('knowledge.search_result')} (${results.length})`, lines.join('\n'));
}

function pickSourceToDelete(
  host: SlashCommandHost,
  sources: KnowledgeSource[],
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const options: ChoiceOption[] = sources.map((s) => ({
    value: s.id,
    label: s.name,
    description: s.filePath ?? undefined,
    tone: 'danger',
  }));
  const picker = new ChoicePickerComponent({
    title: t('knowledge.delete_pick'),
    hint: t('knowledge.cascade_warning'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();
      resolve(value);
    },
    onCancel: () => {
      host.restoreEditor();
      resolve(undefined);
    },
  });
  host.mountEditorReplacement(picker);
  return promise;
}

function confirmDeleteSource(
  host: SlashCommandHost,
  source: KnowledgeSource,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const options: ChoiceOption[] = [
    {
      value: 'cancel',
      label: t('common.cancel'),
      description: t('knowledge.no_delete_data'),
    },
    {
      value: 'confirm',
      label: t('knowledge.confirm_delete'),
      description: `${t('knowledge.cascade_delete')}: ${source.name}`,
      tone: 'danger',
    },
  ];
  const picker = new ChoicePickerComponent({
    title: t('knowledge.confirm_delete_name', { name: source.name }),
    hint: t('knowledge.cascade_warning'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();
      resolve(value === 'confirm');
    },
    onCancel: () => {
      host.restoreEditor();
      resolve(false);
    },
  });
  host.mountEditorReplacement(picker);
  return promise;
}

async function handleDelete(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const sources = await store.listSources();
  if (sources.length === 0) {
    host.showNotice(t('knowledge.empty'), t('knowledge.no_delete'));
    return;
  }

  const sourceId = await pickSourceToDelete(host, sources);
  if (sourceId === undefined) return;

  const source = sources.find((s) => s.id === sourceId);
  if (source === undefined) {
    host.showError(t('knowledge.delete_fail_not_found'));
    return;
  }

  const confirmed = await confirmDeleteSource(host, source);
  if (!confirmed) {
    host.showNotice(t('knowledge.cancelled'), t('knowledge.no_delete'));
    return;
  }

  const ok = await store.deleteSource(sourceId);
  if (ok) {
    host.showNotice(t('knowledge.deleted'), t('knowledge.doc_removed'));
  } else {
    host.showError(t('knowledge.delete_fail_not_found'));
  }
}

function pickSourceToReembed(
  host: SlashCommandHost,
  sources: KnowledgeSource[],
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const options: ChoiceOption[] = sources.map((s) => ({
    value: s.id,
    label: s.name,
    description: s.filePath ?? undefined,
  }));
  const picker = new ChoicePickerComponent({
    title: t('knowledge.reembed_pick'),
    options,
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();
      resolve(value);
    },
    onCancel: () => {
      host.restoreEditor();
      resolve(undefined);
    },
  });
  host.mountEditorReplacement(picker);
  return promise;
}

function confirmReembedSource(host: SlashCommandHost, source: KnowledgeSource): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const options: ChoiceOption[] = [
    {
      value: 'cancel',
      label: t('common.cancel'),
    },
    {
      value: 'confirm',
      label: t('knowledge.reembed'),
      description: t('knowledge.reembed_confirm_desc'),
    },
  ];
  const picker = new ChoicePickerComponent({
    title: t('knowledge.reembed_confirm_name', { name: source.name }),
    options,
    colors: host.state.theme.colors,
    onSelect: (value: string) => {
      host.restoreEditor();
      resolve(value === 'confirm');
    },
    onCancel: () => {
      host.restoreEditor();
      resolve(false);
    },
  });
  host.mountEditorReplacement(picker);
  return promise;
}

async function handleReembed(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const sources = await store.listSources();
  if (sources.length === 0) {
    host.showNotice(t('knowledge.empty'), t('knowledge.reembed_none'));
    return;
  }

  const sourceId = await pickSourceToReembed(host, sources);
  if (sourceId === undefined) return;
  const source = sources.find((s) => s.id === sourceId);
  if (source === undefined) return;

  if (!(await confirmReembedSource(host, source))) {
    host.showNotice(t('knowledge.cancelled'));
    return;
  }

  // Re-embedding recomputes vectors only — the engine must be ready.
  if (!(await ensureEmbeddingReadyInteractive(host))) return;

  const engine = store.getEmbeddingEngine();
  if (engine === undefined) {
    host.showError(t('knowledge.model_missing'));
    return;
  }

  const spinner = host.showProgressSpinner(t('knowledge.reembed'));
  try {
    const counts = await store.reembedSource(sourceId, engine);
    spinner.stop({ ok: true, label: t('knowledge.reembed_done') });
    host.showNotice(
      t('knowledge.reembed_done'),
      t('knowledge.reembed_summary', {
        chunks: String(counts.chunks),
        events: String(counts.events),
        entities: String(counts.entities),
        relations: String(counts.relations),
      }),
    );
  } catch (error) {
    spinner.stop({ ok: false, label: t('knowledge.reembed') });
    throw error;
  }
}

async function handleDownloadModel(host: SlashCommandHost): Promise<void> {
  // Ensure the store and shared embedding engine are initialized before
  // attempting a manual download. The menu can be opened without any other
  // handler having triggered getKnowledgeStore().
  await getKnowledgeStore();

  const spinner = host.showProgressSpinner(t('kw.embedding_downloading'));
  try {
    const { ok, alreadyReady, error } = await startManualEmbeddingDownload();
    spinner.stop({ ok, label: ok ? t('kw.embedding_ready') : t('kw.embedding_failed') });
    if (ok) {
      host.showStatus(alreadyReady ? t('kw.embedding_already_installed') : t('kw.embedding_ready'));
    } else {
      const detail = [t('knowledge.download_model_retry_hint'), error].filter(Boolean).join('\n');
      host.showNotice(t('kw.embedding_failed'), detail);
    }
  } catch (error: unknown) {
    spinner.stop({ ok: false, label: t('kw.embedding_failed') });
    const msg = error instanceof Error ? error.message : String(error);
    host.showError(t('knowledge.op_failed', { msg }));
  }
}

async function handleStats(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const stats = await store.stats();
  const lines: string[] = [
    t('knowledge.stats'),
    '─────────────',
    `sources:   ${stats.sources}`,
    `documents: ${stats.documents}`,
    `chunks:    ${stats.chunks}`,
    `events:    ${stats.events}`,
    `entities:  ${stats.entities}`,
    '',
    `${t('knowledge.stats_note')}:`,
    `  sources   = ${t('knowledge.stats_sources')}`,
    `  documents = ${t('knowledge.stats_documents')}`,
    `  chunks    = ${t('knowledge.stats_chunks')}`,
    `  events    = ${t('knowledge.stats_events')}`,
    `  entities  = ${t('knowledge.stats_entities')}`,
  ];
  await showResultViewer(host, t('knowledge.stats'), lines.join('\n'));
}

export async function handleKnowledgeCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  const formatEmbeddingHint = (status: EmbeddingStatus): string => {
    switch (status) {
      case 'ready':
        return '';
      case 'downloading':
        return ' · ' + t('kw.embedding_downloading');
      case 'failed':
        return ' · ' + t('kw.embedding_failed') + t('kw.embedding_data_intact');
      case 'idle':
        return ' · ' + t('kw.embedding_not_downloaded') + t('kw.embedding_data_intact');
    }
  };

  const showMenu = (): void => {
    const status = getEmbeddingStatus();
    const options: ChoiceOption[] = [
      {
        value: 'download-model',
        label:
          '⬇️ ' +
          t('knowledge.download_model') +
          (status === 'ready' ? t('knowledge.download_model_installed') : ''),
        description: t('knowledge.download_model_desc'),
      },
      {
        value: 'ingest',
        label: '📥 ' + t('knowledge.ingest'),
        description: t('knowledge.ingest_full'),
      },
      {
        value: 'list',
        label: '📋 ' + t('knowledge.doc_list'),
        description: t('knowledge.doc_list_desc'),
      },
      {
        value: 'search',
        label: '🔍 ' + t('knowledge.search'),
        description: t('knowledge.search_effect'),
      },
      {
        value: 'delete',
        label: '🗑️ ' + t('knowledge.delete'),
        description: t('knowledge.delete_desc'),
        tone: 'danger',
      },
      {
        value: 'reembed',
        label: '🔁 ' + t('knowledge.reembed'),
        description: t('knowledge.reembed_desc'),
      },
      {
        value: 'stats',
        label: '📊 ' + t('knowledge.stats'),
        description: t('knowledge.stats_desc'),
      },
      {
        value: 'web',
        label: '🌐 ' + t('knowledge.web'),
        description: t('knowledge.web_desc'),
      },
    ];

    const picker = new ChoicePickerComponent({
      title: t('knowledge.menu_title'),
      hint: t('knowledge.menu_hint') + formatEmbeddingHint(status),
      options,
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        void (async () => {
          host.restoreEditor();
          try {
            if (value === 'download-model') await handleDownloadModel(host);
            else if (value === 'ingest') await handleIngest(host);
            else if (value === 'list') await handleList(host);
            else if (value === 'search') await handleSearch(host);
            else if (value === 'delete') await handleDelete(host);
            else if (value === 'reembed') await handleReembed(host);
            else if (value === 'stats') await handleStats(host);
            else if (value === 'web') await handleWeb(host);
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            host.showError(t('knowledge.op_failed', { msg }));
          }
          showMenu();
        })();
      },
      onCancel: () => {
        host.restoreEditor();
      },
    });
    host.mountEditorReplacement(picker);
  };

  showMenu();
}
