import { useTabsStore, retitle } from "../tabs/tabsStore";
import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { HashIcon, LockIcon, PlusIcon } from "lucide-react";
import { ChatConversation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { SidebarMenuButton } from "../../components/ui/sidebar";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { channels, chatRpc, useChatRead } from "./client";
const decodeChatConversation = Schema.decodeUnknownSync(ChatConversation);

export const chatHref = (id: string, root?: string) =>
  "/channels/" + encodeURIComponent(id) + (root ? "?thread=" + encodeURIComponent(root) : "");
export function ChannelRows({
  enterprise,
  onOpen,
}: {
  enterprise: EnterpriseFeed;
  onOpen: () => void;
}) {
  const { environmentId, relayOrigin } = enterprise.target;
  const load = () => channels({ environmentId, relayOrigin });
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const rows = useChatRead(load, enterprise.feed.chatRevision ?? 0);
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
        "#" +
        channel.name +
        (route.searchParams.has("thread") ? " / Thread" : "") +
        (channel.me.mentions ? " (" + channel.me.mentions + ")" : "");
      if (tab.title !== title) retitle(tab.id, title);
    }
  }, [rows.value, tabs, enterprise.workspace.id]);
  function open(id: string) {
    onOpen();
    void router.navigate({ href: chatHref(id) });
  }
  return (
    <section data-chat-sidebar>
      <header className="mt-3 flex items-center justify-between px-2 text-xs font-semibold text-muted-foreground">
        Channels
        <button aria-label="Create channel" onClick={() => setCreating(!creating)}>
          <PlusIcon size={15} />
        </button>
      </header>
      {creating && (
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
              setCreating(false);
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
      {rows.value?.map((c) => (
        <SidebarMenuButton key={c.id} data-unread={c.me.unread > 0} onClick={() => open(c.id)}>
          {c.private ? <LockIcon /> : <HashIcon />}
          <span>{c.name}</span>
          {c.me.mentions > 0 && <b>{c.me.mentions}</b>}
        </SidebarMenuButton>
      ))}
      <header className="mt-3 px-2 text-xs font-semibold text-muted-foreground">
        Direct messages
      </header>
    </section>
  );
}
