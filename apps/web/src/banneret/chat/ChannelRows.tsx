import { useTabsStore, retitle } from "../tabs/tabsStore";
import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { HashIcon, LockIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { ChatConversation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { DmSettings } from "./AgentSettings";
import { handles, conversations, conversationTitle, chatRpc, useChatRead } from "./client";
const decodeChatConversation = Schema.decodeUnknownSync(ChatConversation);

export const chatHref = (id: string, root?: string, message?: string) => {
  const query = new URLSearchParams();
  if (root) query.set("thread", root);
  if (message) query.set("message", message);
  return "/channels/" + encodeURIComponent(id) + (query.size ? "?" + query : "");
};
export function ChannelRows({
  enterprise,
  onOpen,
}: {
  enterprise: EnterpriseFeed;
  onOpen: () => void;
}) {
  const { environmentId, relayOrigin } = enterprise.target;
  const load = () => conversations({ environmentId, relayOrigin });
  const router = useRouter();
  const [creating, setCreating] = useState<"channel" | "dm" | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const rows = useChatRead(load, enterprise.feed.chatRevision ?? 0);
  const agentList = useChatRead(
    () =>
      enterprise.feed.chatFlags?.includes("agent_dms") && creating === "dm"
        ? handles(enterprise.target)
        : Promise.resolve([]),
    String(creating) + ":" + (enterprise.feed.chatRevision ?? 0),
  );
  const login = enterprise.enrolment.me?.login;
  const tabs = useTabsStore((s) => s.tabs);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep every open chat tab's mention count current
  useEffect(() => {
    if (!rows.value) return;
    for (const tab of tabs) {
      if (tab.kind !== "chat" || tab.workspaceId !== enterprise.workspace.id) continue;
      const route = new URL(tab.href, location.origin);
      const channel = rows.value.find((c) => chatHref(c.id) === route.pathname);
      if (!channel) continue;
      const title =
        conversationTitle(channel, login) +
        (route.searchParams.has("thread") ? " / Thread" : "") +
        (channel.me.mentions ? " (" + channel.me.mentions + ")" : "");
      if (tab.title !== title) retitle(tab.id, title);
    }
  }, [rows.value, tabs, enterprise.workspace.id, login]);
  function open(id: string) {
    onOpen();
    void router.navigate({ href: chatHref(id) });
  }
  return (
    <section data-chat-sidebar>
      <header className="mt-3 flex items-center justify-between px-2 text-xs font-semibold text-muted-foreground">
        Channels
        <button
          aria-label="Create channel"
          onClick={() => setCreating(creating === "channel" ? null : "channel")}
        >
          <PlusIcon size={15} />
        </button>
      </header>
      {creating === "channel" && (
        <form
          className="grid gap-2 p-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending) return;
            const data = new FormData(e.currentTarget);
            setPending(true);
            try {
              const c = decodeChatConversation(
                await chatRpc.run(enterprise.target, {
                  kind: "create",
                  name: String(data.get("name")).trim(),
                  purpose: String(data.get("purpose")).trim(),
                  private: data.has("private"),
                }),
              );
              setCreating(null);
              setError("");
              open(c.id);
            } catch (e) {
              setError(String(e));
            }
            setPending(false);
          }}
        >
          <input name="name" placeholder="Channel name" aria-label="Channel name" required />
          <input name="purpose" aria-label="Purpose" placeholder="Purpose" />
          {enterprise.feed.chatFlags?.includes("private_channels") && (
            <label>
              <input name="private" type="checkbox" /> Private channel
            </label>
          )}
          <button disabled={pending}>Create</button>
        </form>
      )}
      {(error || rows.error) && <p role="alert">{error || rows.error}</p>}
      {rows.value
        ?.filter((c) => c.kind === "channel")
        .map((c) => (
          <SidebarMenuButton key={c.id} data-unread={c.me.unread > 0} onClick={() => open(c.id)}>
            {c.private ? <LockIcon /> : <HashIcon />}
            <span>{c.name}</span>
            {c.me.mentions > 0 && <b>{c.me.mentions}</b>}
          </SidebarMenuButton>
        ))}
      {enterprise.feed.chatFlags?.includes("dms") && (
        <>
          <header className="mt-3 flex items-center justify-between px-2 text-xs font-semibold text-muted-foreground">
            Direct messages
            <button
              aria-label="Start direct message"
              onClick={() => setCreating(creating === "dm" ? null : "dm")}
            >
              <PlusIcon size={15} />
            </button>
          </header>
          {creating === "dm" && (
            <form
              data-chat-dm-picker
              onSubmit={async (e) => {
                e.preventDefault();
                const members = new FormData(e.currentTarget).getAll("recipient").map(String);
                if (
                  !members.length ||
                  members.length > (enterprise.feed.chatFlags?.includes("group_dms") ? 7 : 1)
                ) {
                  setError(
                    enterprise.feed.chatFlags?.includes("group_dms")
                      ? "Choose one to seven other people."
                      : "Choose one other person.",
                  );
                  return;
                }
                if (pending) return;
                setPending(true);
                try {
                  const dm = decodeChatConversation(
                    await chatRpc.run(enterprise.target, { kind: "dm", members }),
                  );
                  setCreating(null);
                  setError("");
                  open(dm.id);
                } catch (e) {
                  setError(String(e));
                }
                setPending(false);
              }}
            >
              <fieldset>
                <legend>Choose recipients</legend>
                {enterprise.feed.team?.value?.people
                  .filter((p) => p.login !== login)
                  .map((p) => (
                    <label key={p.id}>
                      <input
                        name="recipient"
                        value={p.id}
                        type={
                          enterprise.feed.chatFlags?.includes("group_dms") ? "checkbox" : "radio"
                        }
                      />{" "}
                      {p.login}
                    </label>
                  ))}
                {agentList.value
                  ?.filter(
                    (h) =>
                      enterprise.feed.chatFlags?.includes("others_agents") || h.owner === login,
                  )
                  .map((h) => (
                    <label key={h.id}>
                      <input name="recipient" value={h.id} type="checkbox" /> {h.login} · Agent
                    </label>
                  ))}
              </fieldset>
              <button disabled={pending}>Open conversation</button>
            </form>
          )}
          {enterprise.feed.chatFlags?.includes("agent_owner_dm_read") && (
            <DmSettings enterprise={enterprise} />
          )}
          {rows.value
            ?.filter((c) => c.kind === "dm")
            .map((c) => (
              <SidebarMenuButton
                key={c.id}
                data-unread={c.me.unread > 0}
                onClick={() => open(c.id)}
              >
                <MessageSquareIcon />
                <span>{conversationTitle(c, login)}</span>
                {c.me.mentions > 0 && <b>{c.me.mentions}</b>}
              </SidebarMenuButton>
            ))}
        </>
      )}
    </section>
  );
}
