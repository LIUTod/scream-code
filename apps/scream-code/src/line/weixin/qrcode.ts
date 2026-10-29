/**
 * Native WeChat QR login for the /line wizard — no the reference required.
 *
 * Direct port of the official ilink gateway login flow (same endpoints
 * the reference's `weixin setup` calls, see cc core/setup.go):
 *   1. GET {base}/ilink/bot/get_bot_qrcode?bot_type=3
 *      → {qrcode: <key>, qrcode_img_content: <login URL>}
 *   2. GET {base}/ilink/bot/get_qrcode_status?qrcode=<key>
 *      (header iLink-App-ClientVersion: 1, server-side long poll ~37s)
 *      → {status: "wait"} … until {status: "confirmed", bot_token,
 *         ilink_user_id, ilink_bot_id, baseurl}
 *
 * No auth headers here — the login endpoints are pre-auth by design.
 */

export interface WeixinQRBegin {
  qrKey: string;
  qrUrl: string;
}

export interface WeixinQRConfirmed {
  status: 'confirmed';
  botToken: string;
  ilinkUserId: string;
  ilinkBotId: string;
  baseUrl: string;
}

export interface WeixinQRWait {
  status: 'wait';
}

export type WeixinQRPoll = WeixinQRConfirmed | WeixinQRWait;

export class WeixinLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeixinLoginError';
  }
}

const BEGIN_TIMEOUT_MS = 15_000;
const POLL_TIMEOUT_MS = 40_000;
const CHANNEL_VERSION = 'scream-line-weixin/1.0';

function gatewayRoot(baseUrl: string | undefined): string {
  return (baseUrl?.trim() || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
}

/** Step 1 — request a fresh login QR from the official gateway. */
export async function beginWeixinQRLogin(
  options: { baseUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<WeixinQRBegin> {
  const url = `${gatewayRoot(options.baseUrl)}/ilink/bot/get_bot_qrcode?bot_type=3`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(BEGIN_TIMEOUT_MS) });
  } catch (error) {
    throw new WeixinLoginError(`网络错误，无法连接微信 ilink 网关：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status !== 200) {
    throw new WeixinLoginError(`获取登录二维码失败（HTTP ${response.status}）`);
  }
  let body: { qrcode?: unknown; qrcode_img_content?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new WeixinLoginError('微信网关返回异常（无法解析二维码响应）');
  }
  const qrKey = typeof body.qrcode === 'string' ? body.qrcode : '';
  const qrUrl = typeof body.qrcode_img_content === 'string' ? body.qrcode_img_content.trim() : '';
  if (qrKey === '' || qrUrl === '') {
    throw new WeixinLoginError('微信网关未返回有效的登录二维码');
  }
  return { qrKey, qrUrl };
}

/**
 * Step 2 — one long-poll round on the QR status. Resolves with "wait" while
 * the user has not confirmed, and with the token on confirmation. Network
 * hiccups during a round resolve as "wait" (the reference parity), permanent
 * HTTP failures throw.
 */
export async function pollWeixinQRStatus(
  options: { baseUrl?: string },
  qrKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WeixinQRPoll> {
  const url = `${gatewayRoot(options.baseUrl)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrKey)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'iLink-App-ClientVersion': '1', 'X-Channel-Version': CHANNEL_VERSION },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  } catch {
    // Transient network error mid-poll — keep waiting (the reference parity).
    return { status: 'wait' };
  }
  if (response.status !== 200) {
    throw new WeixinLoginError(`查询扫码状态失败（HTTP ${response.status}）`);
  }
  let body: {
    status?: unknown;
    bot_token?: unknown;
    ilink_user_id?: unknown;
    ilink_bot_id?: unknown;
    baseurl?: unknown;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new WeixinLoginError('微信网关返回异常（无法解析扫码状态）');
  }
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (status === '' || status === 'wait') {
    return { status: 'wait' };
  }
  if (status !== 'confirmed') {
    throw new WeixinLoginError(`扫码状态异常：${status}（请重新获取二维码）`);
  }
  const botToken = typeof body.bot_token === 'string' ? body.bot_token.trim() : '';
  if (botToken === '') {
    throw new WeixinLoginError('扫码已确认但网关未返回 token，请重试');
  }
  return {
    status: 'confirmed',
    botToken,
    ilinkUserId: typeof body.ilink_user_id === 'string' ? body.ilink_user_id.trim() : '',
    ilinkBotId: typeof body.ilink_bot_id === 'string' ? body.ilink_bot_id.trim() : '',
    baseUrl: typeof body.baseurl === 'string' ? body.baseurl.trim() : '',
  };
}
