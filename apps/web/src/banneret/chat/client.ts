import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  BANNERET_RELAY_FEED_WS_METHODS,
  type ChannelAction,
  ChatConversations,
  type ChatConversation,
  ChatMembers,
  ChatHandles,
  ChatMessages,
  ChatThread,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState, useEffect, useEffectEvent } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { connectionAtomRuntime } from "../../connection/runtime";
import type { RelayTarget } from "../enrolmentStore";
const decodeChatConversations = Schema.decodeUnknownSync(ChatConversations);
const decodeChatThread = Schema.decodeUnknownSync(ChatThread);
const decodeChatMembers = Schema.decodeUnknownSync(ChatMembers);
const decodeChatMessages = Schema.decodeUnknownSync(ChatMessages);

const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:company-chat",
  tag: BANNERET_RELAY_FEED_WS_METHODS.chat,
});
export const chatRpc = {
  async run({ environmentId, relayOrigin }: RelayTarget, action: ChannelAction) {
    const result = await runAtomCommand(appAtomRegistry, command, {
      environmentId,
      input: { relayOrigin, action },
    });
    if (result._tag !== "Success") throw new Error("Cannot reach this machine.");
    if (!result.value.ok) throw new Error(result.value.message);
    return result.value.value;
  },
};
export async function conversations(target: RelayTarget) {
  const result = [];
  let cursor: string | null = null;
  do {
    const page = decodeChatConversations(
      await chatRpc.run(target, { kind: "list", ...(cursor ? { cursor } : {}) }),
    );
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
export function conversationTitle(c: ChatConversation, login?: string) {
  if (c.kind === "channel") return "#" + c.name;
  return c.members
    .flatMap((m) => (m.kind === "agent" ? [m.handle] : m.login === login ? [] : [m.login]))
    .join(", ");
}
export async function replyAuthors(target: RelayTarget, root: string) {
  const page = decodeChatThread(await chatRpc.run(target, { kind: "replyPreview", id: root }));
  return [
    ...new Set(page.items.flatMap((m) => (m.author.kind === "person" ? [m.author.login] : []))),
  ];
}
export async function history(
  target: RelayTarget,
  id: string,
  root: string | undefined,
  pages: number,
  readSeq?: number,
) {
  const items = [];
  let cursor: string | null = null;
  let remaining = pages;
  while (remaining > 0) {
    const extra = cursor ? { cursor } : {};
    if (root) {
      const page = decodeChatThread(
        await chatRpc.run(target, { kind: "thread", id: root, ...extra }),
      );
      if (page.root.conversationId !== id)
        throw new Error("This thread belongs to another channel.");
      if (!cursor) items.push(page.root);
      remaining--;
      items.push(...page.items);
      cursor = page.nextCursor;
    } else {
      const page = decodeChatMessages(
        await chatRpc.run(target, { kind: "messages", id, ...extra }),
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      if (readSeq === undefined || page.items.some((m) => m.seq <= readSeq)) remaining--;
    }
    if (!cursor) break;
  }
  return { items: items.sort((a, b) => a.seq - b.seq), more: cursor !== null };
}
export async function members(target: RelayTarget, id: string) {
  const result = [];
  let cursor: string | null = null;
  do {
    const page = decodeChatMembers(
      await chatRpc.run(target, { kind: "members", id, ...(cursor ? { cursor } : {}) }),
    );
    result.push(...page.items.filter((m) => m.kind === "person"));
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
// A keyed view owns its last good page. Superseded reads cannot publish into it.
export function useChatRead<T>(
  load: (revision: number | string) => Promise<T>,
  revision: number | string,
) {
  const [state, set] = useState<{ value?: T; error?: string }>({});
  const fetchCurrent = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's change watermark and discards stale reads
  useEffect(() => {
    let current = true;
    void fetchCurrent(revision).then(
      (value) => {
        if (current) set({ value });
      },
      (e) => {
        if (current) set((prev) => ({ ...prev, error: String(e.message ?? e) }));
      },
    );
    return () => {
      current = false;
    };
  }, [revision]);
  return state;
}

const decodeHandles = Schema.decodeUnknownSync(ChatHandles);
export async function handles(target: RelayTarget) {
  const result = [];
  let cursor: string | null = null;
  do {
    const page = decodeHandles(
      await chatRpc.run(target, { kind: "handles", ...(cursor ? { cursor } : {}) }),
    );
    result.push(
      ...page.items.map((h) => ({
        id: h.id,
        login: h.owner.login + "/" + (h.shortName ?? h.claimName),
        owner: h.owner.login,
      })),
    );
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
