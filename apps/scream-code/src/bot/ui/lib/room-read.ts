import type { Room } from "../../shared/contracts";

/**
 * Which rooms have something new.
 *
 * The server owns what the last message is; what "already seen" means is local
 * to this browser, so the watermark lives here rather than in a table. A room
 * only counts as unread when the last word came from a Bot — a message the
 * person just sent is not news to them.
 */
const key = (roomId: string): string => `scream.room.read.${roomId}`;

export function markRoomRead(roomId: string): void {
  try {
    window.localStorage.setItem(key(roomId), String(Date.now()));
  } catch {
    // Private mode: an unread dot is not worth failing a page over.
  }
}

export function roomIsUnread(room: Room): boolean {
  if (room.lastSpeakerKind !== "bot" || room.lastMessageAt === null || room.lastMessageAt === undefined) {
    return false;
  }
  try {
    const readAt = Number(window.localStorage.getItem(key(room.id)) ?? 0);
    return room.lastMessageAt > readAt;
  } catch {
    return false;
  }
}
