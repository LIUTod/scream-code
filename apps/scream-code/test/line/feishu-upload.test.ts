import { describe, expect, it, vi } from 'vitest';

import { feishuFileType, FeishuClient } from '#/line/feishu/client';
import type { FeishuRuntimeOptions } from '#/line/config';

function makeClient(im: Record<string, unknown>): FeishuClient {
  const instance = new FeishuClient({ appId: 'a', appSecret: 's' } as unknown as FeishuRuntimeOptions);
  (instance as unknown as { client: unknown }).client = { im };
  return instance;
}

describe('feishuFileType', () => {
  it('maps extensions to the Feishu file_type enum', () => {
    expect(feishuFileType('报告.pdf')).toBe('pdf');
    expect(feishuFileType('doc.DOCX')).toBe('doc');
    expect(feishuFileType('sheet.xlsx')).toBe('xls');
    expect(feishuFileType('slides.pptx')).toBe('ppt');
    expect(feishuFileType('clip.mp4')).toBe('mp4');
    // Unknown types must degrade to `stream`, not throw.
    expect(feishuFileType('archive.zip')).toBe('stream');
  });
});

describe('FeishuClient uploads', () => {
  it('returns the image_key from a nested response', async () => {
    const create = vi.fn(async () => ({ data: { image_key: 'img_v2_1' } }));
    const client = makeClient({ image: { create } });
    await expect(client.uploadImage(Buffer.from('png'))).resolves.toBe('img_v2_1');
    expect(create).toHaveBeenCalledWith({ data: { image_type: 'message', image: Buffer.from('png') } });
  });

  it('returns the file_key from a flat response', async () => {
    const create = vi.fn(async () => ({ file_key: 'file_v2_2' }));
    const client = makeClient({ file: { create } });
    await expect(client.uploadFile(Buffer.from('x'), 'a.pdf', 'pdf')).resolves.toBe('file_v2_2');
  });

  it('fails loudly when the response carries no key', async () => {
    const client = makeClient({ image: { create: vi.fn(async () => ({ data: {} })) } });
    await expect(client.uploadImage(Buffer.from('png'))).rejects.toThrow(/no image_key/);
  });
});
