import type { QueryClient } from "@tanstack/react-query";
import type { Thread } from "../../shared/contracts";
import { queryKeys } from "./api/queries";
import type { BotClient } from "./client";

export interface DeleteThreadOperation {
  readonly botId: string;
  readonly threadId: string;
}

export interface DeletedThread extends DeleteThreadOperation {
  /** Undefined means DELETE succeeded but the follow-up refresh failed. */
  readonly threads: Thread[] | undefined;
}

/** Only a failed DELETE may reject the operation; refresh is best-effort. */
export async function deleteBotThread(
  client: Pick<BotClient, "deleteThread" | "listThreads" | "createThread">,
  { botId, threadId }: DeleteThreadOperation,
): Promise<DeletedThread> {
  await client.deleteThread(threadId);
  try {
    const remaining = await client.listThreads(botId);
    // The runtime seeds a replacement; preserve that invariant for local clients too.
    const threads = remaining.length > 0 ? remaining : [await client.createThread(botId)];
    return { botId, threadId, threads };
  } catch {
    return { botId, threadId, threads: undefined };
  }
}

/** Finish against the operation's Bot, even if the mounted Cockpit has since changed. */
export async function finishThreadDeletion(
  queryClient: QueryClient,
  deleted: DeletedThread,
  route: {
    readonly getPathname: () => string;
    readonly navigateToBot: (botId: string) => Promise<void>;
  },
): Promise<void> {
  const key = queryKeys.threads(deleted.botId);
  await queryClient.cancelQueries({ queryKey: key });
  queryClient.setQueryData<Thread[]>(key, (current) =>
    deleted.threads ?? current?.filter((thread) => thread.id !== deleted.threadId),
  );
  queryClient.removeQueries({ queryKey: queryKeys.messages(deleted.threadId) });
  if (deleted.threads === undefined) {
    // Retry through the query without holding navigation hostage to another GET.
    void queryClient.invalidateQueries({ queryKey: key });
  }
  const deletedPath = `/bots/${encodeURIComponent(deleted.botId)}/threads/${encodeURIComponent(deleted.threadId)}`;
  if (route.getPathname() === deletedPath) {
    await route.navigateToBot(deleted.botId);
  }
}
