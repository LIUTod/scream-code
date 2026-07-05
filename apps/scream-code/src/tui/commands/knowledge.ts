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

import type { SlashCommandHost } from './dispatch';
import { handleWeb } from './knowledge-web';
import { getKnowledgeStore } from './knowledge-store';
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
    case 'chunking':
      return `切分文件中...`;
    case 'embedding-chunks':
      return `嵌入 chunks: ${progress.chunkIndex}/${progress.totalChunks}`;
    case 'extracting':
      return `抽取事件: ${progress.chunkIndex}/${progress.totalChunks}`;
    case 'embedding-events':
      return `嵌入 events: ${progress.chunkIndex}/${progress.totalChunks}`;
    case 'embedding-entities':
      return `嵌入 entities...`;
    case 'embedding-relations':
      return `嵌入关系...`;
    case 'completed':
      return progress.message;
    case 'error':
      return `错误: ${progress.message}`;
  }
}

async function handleIngest(host: SlashCommandHost): Promise<void> {
  const filePath = await promptTextInput(host, '摄入文件/文件夹', {
    subtitle: '输入要摄入的 markdown/txt 文件路径，或包含这些文件的文件夹路径',
    placeholder: '/path/to/doc.md 或 /path/to/docs',
    allowEmpty: false,
  });
  if (filePath === undefined) return;
  if (filePath.trim().length === 0) {
    host.showError('路径不能为空');
    return;
  }

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    host.showError(`路径不存在: ${filePath}`);
    return;
  }

  const store = await getKnowledgeStore();
  const llm = makeLlmCaller(host);
  const spinner = host.showProgressSpinner('开始摄入...');
  try {
    if (stats.isDirectory()) {
      const result = await ingestDirectory(store, llm, filePath, (progress) => {
        spinner.setLabel(formatProgress(progress));
      });
      spinner.stop({ ok: result.failed === 0, label: '批量摄入完成' });
      if (result.failed > 0) {
        const summary = [
          `成功: ${result.succeeded} 个文件`,
          `失败: ${result.failed} 个文件`,
          `总计: ${result.totalChunks} chunks, ${result.totalEvents} events, ${result.totalEntities} entities`,
          '',
          '失败文件:',
          ...result.errors.map((e) => `  • ${basename(e.filePath)}: ${e.message}`),
        ].join('\n');
        host.showNotice('批量摄入完成（部分失败）', summary);
      } else {
        host.showNotice(
          '批量摄入完成',
          `成功: ${result.succeeded} 个文件\n${result.totalChunks} chunks, ${result.totalEvents} events, ${result.totalEntities} entities`,
        );
      }
    } else {
      if (!isSupportedFile(filePath)) {
        spinner.stop({ ok: false, label: '不支持的文件格式' });
        host.showError('仅支持 .md、.markdown、.txt 文件');
        return;
      }
      const result = await ingestFile(store, llm, filePath, (progress) => {
        spinner.setLabel(formatProgress(progress));
      });
      spinner.stop({ ok: true, label: '摄入完成' });
      host.showNotice(
        '摄入完成',
        `文件: ${basename(filePath)}\nchunks: ${result.chunkCount}\nevents: ${result.eventCount}\nentities: ${result.entityCount}`,
      );
    }
  } catch (error) {
    spinner.stop({ ok: false, label: '摄入失败' });
    throw error;
  }
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
    await showResultViewer(host, '知识库文档', '知识库为空，请先用 /knowledge 摄入文档');
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  const tree = new KnowledgeDocumentTree(
    {
      title: '知识库文档',
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
  const query = await promptTextInput(host, '搜索测试', {
    subtitle: '输入查询，测试多跳检索',
    placeholder: '例如：A 公司的竞争对手是谁',
    allowEmpty: false,
  });
  if (query === undefined || query.trim().length === 0) return;

  const store = await getKnowledgeStore();
  const llm = makeLlmCaller(host);
  const spinner = host.showProgressSpinner('搜索中...');
  let results;
  try {
    results = await multiSearch(store, llm, query, { topK: 5 });
  } catch (error) {
    spinner.stop({ ok: false, label: '搜索失败' });
    throw error;
  }
  spinner.stop({ ok: true, label: '搜索完成' });

  if (results.length === 0) {
    await showResultViewer(host, '搜索结果', `查询 "${query}" 未命中任何 chunk`);
    return;
  }

  const lines: string[] = [`查询: ${query}`, ''];
  for (const [i, r] of results.entries()) {
    lines.push(`#${i + 1} [score=${r.score.toFixed(3)}] ${r.heading ?? '(无标题)'}`);
    lines.push(`   来源: ${r.sourceName}`);
    lines.push(`   ${r.content}`);
    lines.push('');
  }
  await showResultViewer(host, `搜索结果 (${results.length})`, lines.join('\n'));
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
    title: '选择要删除的文档',
    hint: '删除后无法恢复，关联的 chunks/events/entities 会级联删除（Esc 取消）',
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
      label: '取消',
      description: '返回，不删除任何数据',
    },
    {
      value: 'confirm',
      label: '确认删除',
      description: `级联删除：${source.name}`,
      tone: 'danger',
    },
  ];
  const picker = new ChoicePickerComponent({
    title: `确认删除「${source.name}」？`,
    hint: '此操作不可恢复，关联的 chunks/events/entities 会级联删除（Esc 取消）',
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
    host.showNotice('知识库为空', '没有可删除的文档');
    return;
  }

  const sourceId = await pickSourceToDelete(host, sources);
  if (sourceId === undefined) return;

  const source = sources.find((s) => s.id === sourceId);
  if (source === undefined) {
    host.showError('删除失败：文档不存在');
    return;
  }

  const confirmed = await confirmDeleteSource(host, source);
  if (!confirmed) {
    host.showNotice('已取消', '未删除任何文档');
    return;
  }

  const ok = await store.deleteSource(sourceId);
  if (ok) {
    host.showNotice('已删除', '文档已从知识库移除');
  } else {
    host.showError('删除失败：文档不存在');
  }
}

async function handleStats(host: SlashCommandHost): Promise<void> {
  const store = await getKnowledgeStore();
  const stats = await store.stats();
  const lines: string[] = [
    '知识库统计',
    '─────────────',
    `sources:   ${stats.sources}`,
    `documents: ${stats.documents}`,
    `chunks:    ${stats.chunks}`,
    `events:    ${stats.events}`,
    `entities:  ${stats.entities}`,
    '',
    '说明:',
    '  sources   = 摄入的文件/来源数',
    '  documents = 文档元数据记录数',
    '  chunks    = 切片数（按标题切分）',
    '  events    = LLM 抽取的融合事件数',
    '  entities  = 去重后的实体数',
  ];
  await showResultViewer(host, '知识库统计', lines.join('\n'));
}

export async function handleKnowledgeCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  const options: ChoiceOption[] = [
    {
      value: 'ingest',
      label: '📥 摄入文件/文件夹',
      description: '从 markdown/txt 文件或文件夹摄入知识（chunk + 抽事件 + 抽实体）',
    },
    {
      value: 'list',
      label: '📋 文档列表',
      description: '查看所有已摄入的文档',
    },
    {
      value: 'search',
      label: '🔍 搜索测试',
      description: '输入查询，测试多跳检索效果',
    },
    {
      value: 'delete',
      label: '🗑️ 删除文档',
      description: '从知识库删除一个文档（级联删除关联数据）',
      tone: 'danger',
    },
    {
      value: 'stats',
      label: '📊 统计信息',
      description: '查看知识库整体统计',
    },
    {
      value: 'web',
      label: '🌐 知识图谱',
      description: '在浏览器中查看交互式知识图谱',
    },
  ];

  const showMenu = (): void => {
    const picker = new ChoicePickerComponent({
      title: 'SAG知识库管理',
      hint: '选择操作（esc 退出）',
      options,
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        void (async () => {
          host.restoreEditor();
          try {
            if (value === 'ingest') await handleIngest(host);
            else if (value === 'list') await handleList(host);
            else if (value === 'search') await handleSearch(host);
            else if (value === 'delete') await handleDelete(host);
            else if (value === 'stats') await handleStats(host);
            else if (value === 'web') await handleWeb();
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            host.showError(`操作失败: ${msg}`);
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
