import { ChatThread, ChatSearch, type ChatAsk, type ChatConversation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { RelayTarget } from "../enrolmentStore";
import { chatRpc } from "./client";
const decodeSearch = Schema.decodeUnknownSync(ChatSearch);
const decodeThread = Schema.decodeUnknownSync(ChatThread);

// The owner's grouped ask list carries no location. Match the exact ask in visible chat history.
export async function askHome(
  target: RelayTarget,
  ask: ChatAsk,
  channels: readonly ChatConversation[],
) {
  const query =
    "kind:ask after:" +
    ask.createdAt.slice(0, 10) +
    " " +
    (ask.question
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 4)
      .join(" ") ?? "");
  let cursor: string | null = null;
  do {
    const page: ChatSearch = decodeSearch(
      await chatRpc.run(target, { kind: "search", query, ...(cursor ? { cursor } : {}) }),
    );
    for (const hit of page.items) {
      if (hit.author.kind !== "agent" || hit.author.id !== ask.from.handle) continue;
      if (!hit.threadRootId) continue;
      const threadRoot = hit.threadRootId;
      let replyCursor: string | null = null;
      let matched = false;
      do {
        const thread: ChatThread = decodeThread(
          await chatRpc.run(target, {
            kind: "thread",
            id: threadRoot,
            ...(replyCursor ? { cursor: replyCursor } : {}),
          }),
        );
        matched = thread.items.some((m) => m.id === hit.messageId && m.ask?.id === ask.id);
        replyCursor = thread.nextCursor;
      } while (replyCursor && !matched);
      if (!matched) continue;
      const people = channels.find((c) => c.id === hit.conversationId)?.memberCount.people;
      return {
        label: hit.conversationName,
        people,
        href:
          "/channels/" +
          encodeURIComponent(hit.conversationId) +
          "?thread=" +
          encodeURIComponent(hit.threadRootId ?? hit.messageId),
      };
    }
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}
