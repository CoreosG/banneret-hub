import { ChatHandle, ChatSettings, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChatHeader as ThreadHeader } from "../../components/chat/ChatHeader";
import { type ComponentProps, useState } from "react";
import { useEnterpriseFeed, type EnterpriseFeed } from "../useEnterpriseFeed";
import { chatRpc, useChatRead } from "./client";
const decodeSettings = Schema.decodeUnknownSync(ChatSettings);
const decodeHandle = Schema.decodeUnknownOption(ChatHandle);

export function DmSettings({ enterprise }: { enterprise: EnterpriseFeed }) {
  const [revision, refresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const setting = useChatRead(
    async () => decodeSettings(await chatRpc.run(enterprise.target, { kind: "dmSettings" })),
    revision + ":" + (enterprise.feed.chatRevision ?? 0),
  );
  return (
    <label className="block p-2 text-xs">
      <input
        type="checkbox"
        checked={setting.value?.agentsReadMyDms ?? false}
        disabled={!setting.value || pending}
        onChange={async (e) => {
          const enabled = e.target.checked;
          setPending(true);
          try {
            await chatRpc.run(enterprise.target, {
              kind: "setDmSettings",
              settings: { agentsReadMyDms: enabled },
            });
            refresh((n) => n + 1);
            setError("");
          } catch (e) {
            setError(String(e));
          }
          setPending(false);
        }}
      />{" "}
      My agents can read my DMs{" "}
      {(error || setting.error) && <span role="alert">{error || setting.error}</span>}
    </label>
  );
}

function AgentThreadHeader({
  environmentId,
  thread,
}: {
  environmentId: EnvironmentId;
  thread: string;
}) {
  const enterprise = useEnterpriseFeed();
  return enterprise?.environmentId === environmentId &&
    enterprise.feed.chatFlags?.includes("agents") ? (
    <ThreadSettings
      key={enterprise.target.relayOrigin + thread}
      enterprise={enterprise}
      thread={thread}
    />
  ) : null;
}
function ThreadSettings({ enterprise, thread }: { enterprise: EnterpriseFeed; thread: string }) {
  const [saved, setSaved] = useState<ChatHandle>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const state = useChatRead(
    () => chatRpc.run(enterprise.target, { kind: "threadChat", thread }),
    thread,
  );
  if (!state.value) return null;
  const h = saved ?? Option.getOrUndefined(decodeHandle(state.value));
  return (
    <details className="relative text-xs">
      <summary className="cursor-pointer">
        {h ? h.owner.login + "/" + (h.shortName ?? h.claimName) : "Give a chat name"}
      </summary>
      <form
        key={h?.shortName + "-" + h?.wake}
        className="absolute right-0 z-30 grid w-64 gap-3 rounded-md border bg-popover p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setPending(true);
          try {
            const updated = await chatRpc.run(enterprise.target, {
              kind: "threadChat",
              thread,
              settings: {
                name: String(data.get("name") ?? ""),
                wake: data.has("ownerOnly") ? "owner_only" : "everyone",
              },
            });
            setSaved(Option.getOrThrow(decodeHandle(updated)));
            setError("");
          } catch (e) {
            setError(String(e));
          }
          setPending(false);
        }}
      >
        <label>
          Chat name{" "}
          <input
            name="name"
            pattern={"[a-z0-9][a-z0-9\\-]{0,31}"}
            defaultValue={h?.shortName ?? ""}
            placeholder={h?.claimName ?? "builder"}
          />
        </label>
        <label>
          <input name="ownerOnly" type="checkbox" defaultChecked={h?.wake === "owner_only"} /> Only
          my messages wake it
        </label>
        <button disabled={pending}>Save</button>
        {error && <span role="alert">{error}</span>}
      </form>
    </details>
  );
}

export function ChatHeader(props: ComponentProps<typeof ThreadHeader>) {
  return (
    <>
      <ThreadHeader {...props} />
      {props.isServerThread && (
        <AgentThreadHeader
          thread={props.activeThreadId}
          environmentId={props.activeThreadEnvironmentId}
        />
      )}
    </>
  );
}
