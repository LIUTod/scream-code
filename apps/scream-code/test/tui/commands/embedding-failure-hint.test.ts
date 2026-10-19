/**
 * embedding-failure-hint.test.ts — 失败文案分型。
 *
 * 修复前四种根因共用一句"建议科学上网"，维护者与用户都会把它当成网络问题；
 * 这里钉住"每类给各自的话"，并防止误导性的代理建议回流到非网络类。
 * WASM 引擎迁移后 platform 类已不存在，首位是"安装被破坏"（install）。
 */
import { t } from '@scream-code/config';
import { describe, expect, it } from 'vitest';

import { embeddingFailureDetail, embeddingFailureHint } from '#/tui/commands/embedding-failure-hint';

describe('embeddingFailureHint', () => {
  it('每种类别各给各自的提示，未知或缺失一律回落', () => {
    expect(embeddingFailureHint('install')).toBe(t('knowledge.embedding_install_hint'));
    expect(embeddingFailureHint('archive')).toBe(t('knowledge.embedding_cache_corrupt_hint'));
    expect(embeddingFailureHint('network')).toBe(t('knowledge.embedding_network_hint'));
    expect(embeddingFailureHint('other')).toBe(t('knowledge.embedding_unknown_hint'));
    expect(embeddingFailureHint(undefined)).toBe(t('knowledge.embedding_unknown_hint'));
  });

  it('展示层只取错误首行（Node 的 Require stack 不该进通知）', () => {
    const detail = embeddingFailureDetail('other', 'first line\nRequire stack:\n- /x/y.mjs');
    expect(detail).toBe(`${t('knowledge.embedding_unknown_hint')}\nfirst line`);
    expect(detail).not.toContain('Require stack');

    // 没有错误时只留提示行
    expect(embeddingFailureDetail('network', undefined)).toBe(t('knowledge.embedding_network_hint'));
  });

  it('代理建议只属于网络类；安装类给可自救的重装命令', () => {
    expect(embeddingFailureHint('network')).toMatch(/代理|proxy/i);

    const install = embeddingFailureHint('install');
    expect(install).not.toMatch(/代理|proxy|科学上网/i);
    expect(install).toContain('npm i -g scream-code');
  });
});
