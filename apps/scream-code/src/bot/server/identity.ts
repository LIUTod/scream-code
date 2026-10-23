import type { BotRecord, ThreadRecord } from './store';
import type { ToolPolicy } from '../shared/contracts';

/** Advanced filters have no equivalent in the public SDK; never persist a lie. */
export function validateToolPolicy(policy: ToolPolicy): void {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy) ||
      Object.keys(policy).some((key) => !['allow', 'handoff'].includes(key)) ||
      (policy.allow !== undefined && (!Array.isArray(policy.allow) || policy.allow.some((name) => typeof name !== 'string' || name.trim().length === 0))) ||
      (policy.handoff !== undefined && typeof policy.handoff !== 'boolean')) {
    throw new Error('Only exact tool allow lists and the handoff switch are supported; deny and advanced policies are unsupported');
  }
}

export function identityPrompt(bot: BotRecord, thread: ThreadRecord, peers: readonly BotRecord[], roomName?: string): string {
  return [
    '## Workbench identity (runtime context)',
    `You are ${JSON.stringify(bot.name)}, Bot ID ${bot.id}. Thread: ${thread.id}${roomName === undefined ? '' : `; room: ${JSON.stringify(roomName)}`}.`,
    `Effective workspace: ${thread.workspace}. This is a working directory, not an execution sandbox.`,
    thread.pinnedRole ? 'This legacy session retains its original profile role. Role changes require a new thread.' : `User role preference: ${JSON.stringify(bot.rolePrompt)}`,
    `Permission: ${bot.permission}. Only actually registered and permitted tools are available. Memory is a shared experience library, not private Bot memory.`,
    `Peers (names are display labels; use stable IDs if ambiguous): ${JSON.stringify(peers.filter((peer) => peer.id !== bot.id).map((peer) => ({id:peer.id,name:peer.name,paused:peer.paused})))}`,
    bot.toolPolicy.handoff === false ? 'Bot-to-Bot sends are disabled.' : "Discover peers with message_bot(action:'list'); send with action:'send', to, task, optional constraints/expecting. One hop, at most three sends per run. Relay runs cannot send again.",
  ].join('\n');
}
