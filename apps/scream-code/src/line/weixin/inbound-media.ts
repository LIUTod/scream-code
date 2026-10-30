/**
 * Inbound media for the WeChat gateway, ported from the reference
 * implementation's `collectInboundMedia`.
 *
 * Images are decrypted and kept in memory (they travel to the model as
 * `image_url` parts); everything else is written under the Scream home and the
 * model receives the path. Voice notes carry an ASR transcript in
 * `voice_item.text` — when it is present the audio itself is not downloaded.
 */

import { log } from '@scream-code/scream-code-sdk';

import {
  MAX_IMAGES_PER_TURN,
  MAX_INBOUND_IMAGE_BYTES,
  saveInboundFile,
  sniffImageMime,
  type LineImageAttachment,
} from '../media';
import {
  buildCdnDownloadUrl,
  decryptAesEcb,
  parseAesKey,
} from './cdn';
import type { IlinkCdnMedia, IlinkMessageItem, WeixinClient } from './client';

export interface CollectedInboundMedia {
  images: LineImageAttachment[];
  files: string[];
  /** At least one item failed to download or decrypt. */
  failed: boolean;
}

export interface CollectInboundOptions {
  client: WeixinClient;
  items: readonly IlinkMessageItem[];
  cdnBaseUrl: string;
  sessionKey: string;
}

/** Image keys arrive either as 32 hex chars or as the base64 CDN form. */
function resolveAesKey(media: IlinkCdnMedia | undefined, hexKey: string | undefined): Buffer | null {
  const raw = (hexKey ?? '').trim();
  if (raw.length === 32 && /^[0-9a-f]{32}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const base64 = (media?.aes_key ?? '').trim();
  if (base64.length === 0) return null;
  return parseAesKey(base64);
}

async function download(
  client: WeixinClient,
  cdnBaseUrl: string,
  media: IlinkCdnMedia | undefined,
): Promise<Buffer> {
  const param = (media?.encrypt_query_param ?? '').trim();
  if (param.length === 0) throw new Error('media without encrypt_query_param');
  return client.fetchCdnBytes(buildCdnDownloadUrl(cdnBaseUrl, param));
}

export async function collectInboundMedia(
  options: CollectInboundOptions,
): Promise<CollectedInboundMedia> {
  const { client, items, cdnBaseUrl, sessionKey } = options;
  const images: LineImageAttachment[] = [];
  const files: string[] = [];
  let failed = false;

  const guarded = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failed = true;
      log.warn('line-weixin: inbound media failed', { label, error: String(error) });
    }
  };

  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;

    if (item.image_item !== undefined) {
      if (images.length >= MAX_IMAGES_PER_TURN) continue;
      await guarded('image', async () => {
        const image = item.image_item;
        const bytes = await download(client, cdnBaseUrl, image?.media);
        const key = resolveAesKey(image?.media, image?.aeskey);
        const plain = key === null ? bytes : decryptAesEcb(bytes, key);
        if (plain.length > MAX_INBOUND_IMAGE_BYTES) {
          throw new Error(`image too large: ${plain.length} bytes`);
        }
        images.push({ mime: sniffImageMime(plain), data: plain });
      });
      continue;
    }

    if (item.file_item !== undefined) {
      await guarded('file', async () => {
        const file = item.file_item;
        const bytes = await download(client, cdnBaseUrl, file?.media);
        const key = resolveAesKey(file?.media, undefined);
        const plain = key === null ? bytes : decryptAesEcb(bytes, key);
        const name = (file?.file_name ?? '').trim() || 'file.bin';
        files.push(await saveInboundFile(sessionKey, name, plain));
      });
      continue;
    }

    if (item.video_item !== undefined) {
      await guarded('video', async () => {
        const video = item.video_item;
        const bytes = await download(client, cdnBaseUrl, video?.media);
        const key = resolveAesKey(video?.media, undefined);
        const plain = key === null ? bytes : decryptAesEcb(bytes, key);
        files.push(await saveInboundFile(sessionKey, 'video.mp4', plain));
      });
      continue;
    }

    if (item.voice_item !== undefined) {
      // The gateway usually attaches an ASR transcript; only fetch the audio
      // when it did not, so text stays the cheap path.
      const hasTranscript = (item.voice_item.text ?? '').trim().length > 0;
      if (hasTranscript || item.voice_item.media === undefined) continue;
      await guarded('voice', async () => {
        const bytes = await download(client, cdnBaseUrl, item.voice_item?.media);
        const key = resolveAesKey(item.voice_item?.media, undefined);
        const plain = key === null ? bytes : decryptAesEcb(bytes, key);
        files.push(await saveInboundFile(sessionKey, 'voice.silk', plain));
      });
    }
  }

  return { images, files, failed };
}
