import { describe, expect, it } from 'vitest';

import {
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from '#/line/weixin/cdn';

describe('parseAesKey', () => {
  it('accepts base64 of the raw 16-byte key', () => {
    const raw = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    expect(parseAesKey(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it('accepts base64 of a 32-character hex string (gateway variant)', () => {
    const hex = '00112233445566778899aabbccddeeff';
    expect(parseAesKey(Buffer.from(hex, 'latin1').toString('base64')).toString('hex')).toBe(hex);
  });

  it('rejects anything else instead of guessing', () => {
    expect(() => parseAesKey(Buffer.from('short').toString('base64'))).toThrow(/aes_key/);
  });
});

describe('AES-128-ECB', () => {
  it('round-trips a buffer', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const plain = Buffer.from('微信图片内容 png bytes');
    const cipher = encryptAesEcb(plain, key);
    expect(cipher.equals(plain)).toBe(false);
    expect(decryptAesEcb(cipher, key).equals(plain)).toBe(true);
  });

  it('refuses a wrongly sized key or unaligned ciphertext', () => {
    const key = Buffer.alloc(16);
    expect(() => decryptAesEcb(Buffer.alloc(15), key)).toThrow(/aligned/);
    expect(() => decryptAesEcb(Buffer.alloc(16), Buffer.alloc(8))).toThrow(/16 bytes/);
  });
});

describe('CDN URLs', () => {
  it('download uses the encrypted_query_param name (not encrypt_query_param)', () => {
    expect(buildCdnDownloadUrl('https://cdn.example/c2c/', 'abc+def')).toBe(
      'https://cdn.example/c2c/download?encrypted_query_param=abc%2Bdef',
    );
  });

  it('upload carries both the pointer and the file key', () => {
    expect(buildCdnUploadUrl('https://cdn.example/c2c', 'p', 'fk')).toBe(
      'https://cdn.example/c2c/upload?encrypted_query_param=p&filekey=fk',
    );
  });
});
