import type { WsMessage } from '../../types';
import type { ClientContext } from './state';

/** WS frame dispatcher: routes each frame to the handler its owning domain
 *  registered via onWsMessage during module assembly.
 *
 *  Structural safeguard (against "silently stale missing registration"): unknown frame
 *  types must fail loud — the production incident stemmed from a switch-case missing the
 *  resync_required handler, leaving the UI permanently stale with no error reported at all.
 *  This only console.errors and counts, it does not throw: the WS message loop must stay
 *  alive and later frames still need to be dispatched. */
export function createDispatch(ctx: ClientContext): (msg: WsMessage) => void {
  const { s } = ctx;
  return function handleMessage(msg: WsMessage): void {
    const handler = s.wsHandlers.get(msg.type);
    if (handler !== undefined) {
      handler(msg);
      return;
    }
    // Explicit fallback: at most one handler per type (the registry is looked up by type,
    // matching the old switch's hit semantics one-to-one, with no ordering dependency);
    // a miss means nothing was registered.
    s.wsUnknownFrames++;
    console.error(
      `[webClient] 收到未注册的 WS 帧类型 "${msg.type}"（第 ${s.wsUnknownFrames} 次），` +
        '该帧已被丢弃；请在对应域模块用 onWsMessage 注册处理器。',
      msg,
    );
  };
}
