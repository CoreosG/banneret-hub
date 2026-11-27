import { createContext, useContext, useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChatConversation } from "@t3tools/contracts";
import { conversations, offersConversation, chatRpc, useChatRead } from "../chat/client";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import type { RelayTarget } from "../enrolmentStore";
type Person = { id: string; login: string };
const Chat = createContext<{
  dms: boolean;
  viewer?: string | undefined;
  channels: Map<string, string>;
  mapping?: Readonly<Record<string, string>> | undefined;
} | null>(null);
export function OfficeChat({
  enterprise,
  children,
}: {
  enterprise: EnterpriseFeed;
  children: ReactNode;
}) {
  const { feed, target } = enterprise;
  const flags = feed.sections.includes("chat") ? (feed.chatFlags ?? []) : [];
  const enabled = flags.includes("channels");
  const rows = useChatRead(
    () => (enabled ? conversations(target) : Promise.resolve([])),
    String(enabled) + ":" + (feed.chatRevision ?? 0),
  );
  const channels = new Map<string, string>();
  if (enabled)
    for (const c of rows.value ?? [])
      if (c.kind === "channel" && offersConversation(c, flags)) {
        channels.set(c.name.toLowerCase(), c.id);
        channels.set(c.id, c.id);
      }
  return (
    <Chat.Provider
      value={{
        channels,
        dms:
          flags.includes("dms") &&
          !!enterprise.enrolment.me?.permissions.some(
            (p) => p === "dm.start:anyone" || p === "dm.start:shared_channel",
          ),
        viewer: enterprise.enrolment.me?.login,
        mapping: feed.boardChannels,
      }}
    >
      {children}
    </Chat.Provider>
  );
}
export function RoomChannel({ board, title }: { board: string; title: string }) {
  const chat = useContext(Chat);
  const configured =
    chat?.mapping && Object.hasOwn(chat.mapping, board) ? chat.mapping[board] : undefined;
  const id = configured
    ? chat?.channels.get(configured)
    : (chat?.channels.get(board.toLowerCase()) ?? chat?.channels.get(title.toLowerCase()));
  return id ? (
    <Link
      className="underline"
      to="/channels/$channelId"
      params={{ channelId: id }}
      search={{ thread: undefined, message: undefined }}
    >
      Open channel
    </Link>
  ) : null;
}
export function Message({ person, target }: { person: Person; target: RelayTarget }) {
  const chat = useContext(Chat);
  return chat?.dms && chat.viewer !== person.login ? (
    <DirectMessage person={person} target={target} />
  ) : null;
}
const decodeConversation = Schema.decodeUnknownSync(ChatConversation);
function DirectMessage({ person, target }: { person: Person; target: RelayTarget }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        disabled={pending}
        aria-label={"Direct message " + person.login}
        onClick={async () => {
          setPending(true);
          try {
            const dm = decodeConversation(
              await chatRpc.run(target, { kind: "dm", members: [person.id] }),
            );
            await router.navigate({ href: "/channels/" + encodeURIComponent(dm.id) });
          } catch (e) {
            setError(String(e));
          }
          setPending(false);
        }}
      >
        Message
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
