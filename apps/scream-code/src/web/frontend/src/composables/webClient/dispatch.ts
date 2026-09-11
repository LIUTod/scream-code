import type { WsMessage } from '../../types';
import type { ClientContext } from './state';

/** WS frame dispatcher: routes each frame to the handler its owning domain
 *  registered (see onWsMessage). Unknown frame types are ignored, matching
 *  the original switch's default behaviour. */
export function createDispatch(ctx: ClientContext): (msg: WsMessage) => void {
  const { s } = ctx;
  return function handleMessage(msg: WsMessage): void {
    s.wsHandlers.get(msg.type)?.(msg);
  };
}
