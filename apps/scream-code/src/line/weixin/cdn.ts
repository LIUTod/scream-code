/**
 * WeChat CDN helpers, ported from the reference implementation
 * (`platform/weixin/cdn.go`).
 *
 * Media lives on the ilink CDN, not behind the bot API: the gateway hands out an
 * opaque `encrypt_query_param` plus an AES key, the body is AES-128-ECB +
 * PKCS#7 encrypted, and the download URL is `…/download?encrypted_query_param=`.
 * Note the URL parameter is `encrypted_query_param` while the JSON field is
 * `encrypt_query_param` — mixing them up yields a 400 with no diagnostics.
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';

export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** Same ceiling as the reference; larger bodies are treated as an error. */
export const MAX_CDN_BYTES = 100 * 1024 * 1024;

const AES_BLOCK_SIZE = 16;
const HEX32 = /^[0-9a-f]{32}$/i;

/**
 * Decodes `CDNMedia.aes_key`: base64 of the raw 16 bytes, or base64 of a
 * 32-character hex string (the gateway uses both forms depending on the item).
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64.trim(), 'base64');
  if (decoded.length === AES_BLOCK_SIZE) return decoded;
  if (decoded.length === 32) {
    const asText = decoded.toString('latin1');
    if (HEX32.test(asText)) return Buffer.from(asText, 'hex');
  }
  throw new Error(`aes_key must be 16 raw bytes or 32-char hex (base64-wrapped), got ${decoded.length}`);
}

/** AES-128-ECB with PKCS#7 (Node's default block padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== AES_BLOCK_SIZE) throw new Error(`aes key must be 16 bytes, got ${key.length}`);
  if (ciphertext.length % AES_BLOCK_SIZE !== 0) {
    throw new Error(`ciphertext length ${ciphertext.length} not aligned to block`);
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== AES_BLOCK_SIZE) throw new Error(`aes key must be 16 bytes, got ${key.length}`);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function buildCdnDownloadUrl(cdnBase: string, encryptedQueryParam: string): string {
  return `${cdnBase.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(cdnBase: string, uploadParam: string, filekey: string): string {
  return `${cdnBase.replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}
