import { Link } from "@tanstack/react-router";
import { PauseControls } from "../Pause";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { AskSettings } from "./AskSettings";
import { CallApprovals } from "../CallApprovals";
import { ThreadToolLevels } from "../ThreadToolLevels";
import { MemoryStrip } from "../MemoryStrip";
import { ChatHandle, ChatSettings, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ThreadTimeline as Timeline } from "../../components/chat/ThreadTimeline";
import { type ComponentProps, useState } from "react";
import { useEnterpriseFeed, type EnterpriseFeed } from "../useEnterpriseFeed";
import { feedRpc } from "../relayFeedStore";
import { chatRpc, useChatRead } from "./client";
const decodeSettings = Schema.decodeUnknownSync(ChatSettings);
const decodeHandle = Schema.decodeUnknownOption(ChatHandle);

function useDmSettings(enterprise: EnterpriseFeed) {
  const [revision, refresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const setting = useChatRead(
    async () => decodeSettings(await chatRpc.run(enterprise.target, { kind: "dmSettings" })),
    revision + ":" + (enterprise.feed.chatRevision ?? 0),
  );
  const settings = setting.value;
  async function save(action: Parameters<typeof chatRpc.run>[1]) {
    setPending(true);
    try {
      await chatRpc.run(enterprise.target, action);
      refresh((n) => n + 1);
      setError("");
    } catch (e) {
      setError(String(e));
    }
    setPending(false);
  }
  return { settings, pending, save, error: error || setting.error };
}

/** The person's default for new agents, and the button that applies it to the existing ones. */
function WakeDefault({
  settings,
  save,
}: {
  settings: ChatSettings | undefined;
  save: (action: Parameters<typeof chatRpc.run>[1]) => Promise<void>;
}) {
  return (
    <>
      <label>
        Who can wake new agents{" "}
        <select
          aria-label="Who can wake new agents"
          value={settings?.agentWakeDefault ?? "everyone"}
          onChange={(e) =>
            settings &&
            void save({
              kind: "setDmSettings",
              settings: { ...settings, agentWakeDefault: wakeValue(e.target.value) },
            })
          }
        >
          <WakeOptions />
        </select>
      </label>
      <button
        onClick={() =>
          settings && void save({ kind: "applyWake", wake: settings.agentWakeDefault })
        }
      >
        Apply to all my agents
      </button>
    </>
  );
}

/** Settings > Chat. The section always renders, so a search for "wake" has somewhere to land. */
export function AgentWakeSetting() {
  const enterprise = useEnterpriseFeed();
  return (
    <SettingsSection id="agent-wake" title="Wake agents">
      {enterprise?.feed.chatFlags?.includes("agent_inbox") ? (
        <WakeDefaultRow key={enterprise.target.relayOrigin} enterprise={enterprise} />
      ) : (
        <SettingsRow
          title="Who can wake your agents"
          description="Switch to a company workspace whose relay delivers messages to agents to choose this."
        />
      )}
    </SettingsSection>
  );
}
function WakeDefaultRow({ enterprise }: { enterprise: EnterpriseFeed }) {
  const { settings, pending, save, error } = useDmSettings(enterprise);
  return (
    <SettingsRow
      title={`Who can wake your agents in ${enterprise.workspace.name}`}
      description={
        enterprise.feed.chatFlags?.includes("agents")
          ? "The default for new agents. Change one agent from its thread header."
          : "The default for new agents. This relay does not offer a separate setting for each agent yet."
      }
      status={error}
      control={
        <fieldset className="flex flex-wrap items-center gap-2" disabled={!settings || pending}>
          <WakeDefault settings={settings} save={save} />
        </fieldset>
      }
    />
  );
}

export function DmSettings({ enterprise }: { enterprise: EnterpriseFeed }) {
  const { settings, pending, save, error } = useDmSettings(enterprise);
  return (
    <fieldset className="grid gap-2 p-2 text-xs" disabled={!settings || pending}>
      {enterprise.feed.chatFlags?.includes("agent_owner_dm_read") && (
        <label>
          <input
            type="checkbox"
            checked={settings?.agentsReadMyDms ?? false}
            onChange={(e) =>
              settings &&
              void save({
                kind: "setDmSettings",
                settings: { ...settings, agentsReadMyDms: e.target.checked },
              })
            }
          />{" "}
          My agents can read my DMs
        </label>
      )}
      {enterprise.feed.chatFlags?.includes("agent_inbox") && (
        <WakeDefault settings={settings} save={save} />
      )}
      {settings && enterprise.feed.chatFlags?.includes("agent_asks") && (
        <AskSettings
          enterprise={enterprise}
          policy={settings.agentAsks}
          save={(agentAsks) =>
            void save({ kind: "setDmSettings", settings: { ...settings, agentAsks } })
          }
        />
      )}
      {settings && enterprise.feed.chatFlags?.includes("handoffs") && (
        <fieldset className="grid gap-1">
          <legend>Automatically accept hand-offs from</legend>
          {enterprise.feed.team?.value?.people
            .filter((p) => p.id !== enterprise.enrolment.me?.id)
            .map((p) => {
              const rules = settings.agentAsks.auto;
              const checked = rules.some(
                (r) =>
                  "person" in r.from &&
                  r.from.person.id === p.id &&
                  r.kinds.some((k) => k === "handoff"),
              );
              return (
                <label key={p.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const auto: typeof rules = checked
                        ? rules
                            .map((r) =>
                              "person" in r.from && r.from.person.id === p.id
                                ? { from: r.from, kinds: r.kinds.filter((k) => k !== "handoff") }
                                : r,
                            )
                            .filter((r) => r.kinds.length)
                        : [
                            ...rules,
                            { from: { person: { id: p.id, login: p.login } }, kinds: ["handoff"] },
                          ];
                      void save({
                        kind: "setDmSettings",
                        settings: { ...settings, agentAsks: { ...settings.agentAsks, auto } },
                      });
                    }}
                  />{" "}
                  {p.login}
                </label>
              );
            })}
        </fieldset>
      )}
      {error && <span role="alert">{error}</span>}
    </fieldset>
  );
}
function wakeValue(value: FormDataEntryValue | null) {
  return value === "owner" || value === "nobody" ? value : "everyone";
}
const wakeLabels = { everyone: "Everyone", owner: "Only me", nobody: "Nobody" } as const;
function WakeOptions() {
  return Object.entries(wakeLabels).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

export function AgentThreadHeader({
  environmentId,
  thread,
}: {
  environmentId: EnvironmentId;
  thread: string;
}) {
  const enterprise = useEnterpriseFeed();
  if (enterprise?.environmentId !== environmentId) return null;
  if (enterprise.feed.chatFlags?.includes("agents"))
    return (
      <ThreadSettings
        key={enterprise.target.relayOrigin + thread}
        enterprise={enterprise}
        thread={thread}
      />
    );
  // A relay with an agent inbox but no per-agent handles still has the person's wake default.
  return enterprise.feed.chatFlags?.includes("agent_inbox") ? (
    <Link
      className="text-xs underline"
      to="/settings/chat"
      hash="agent-wake"
      hashScrollIntoView={false}
    >
      Wake settings
    </Link>
  ) : null;
}
function ThreadSettings({ enterprise, thread }: { enterprise: EnterpriseFeed; thread: string }) {
  const [revision, refresh] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const state = useChatRead(
    () => chatRpc.run(enterprise.target, { kind: "threadChat", thread }),
    [thread, revision, enterprise.feed.chatRevision].join(":"),
  );
  const h = Option.getOrUndefined(decodeHandle(state.value));
  const defaults = useChatRead(
    async () =>
      state.value && !h
        ? decodeSettings(await chatRpc.run(enterprise.target, { kind: "dmSettings" }))
            .agentWakeDefault
        : null,
    [Boolean(state.value), h?.id, revision].join(":"),
  );
  const feed = enterprise.feed;
  const direct = feed.needs?.find(
    (item) => item.kind === "agent_inbox" && item.handleId === h?.id,
  )?.count;
  const more = useChatRead(async () => {
    if (!h || direct !== undefined || !feed.chatFlags?.includes("agent_inbox")) return undefined;
    let cursor = feed.needsNextCursor;
    while (cursor) {
      const page = (await feedRpc.needs(enterprise.target, cursor))?.value;
      if (!page) break;
      const item = page.items.find((item) => item.kind === "agent_inbox" && item.handleId === h.id);
      if (item) return item.count;
      cursor = page.nextCursor;
    }
    return undefined;
  }, [h?.id, direct, feed.needsFetchedAt, feed.needsNextCursor].join(":"));
  const waiting = direct ?? more.value;
  if (!state.value) return null;
  return (
    <details
      className="relative text-xs"
      onToggle={(e) => {
        if (e.currentTarget.open) refresh((n) => n + 1);
      }}
    >
      <summary className="cursor-pointer">
        {h ? h.owner.login + "/" + (h.shortName ?? h.claimName) : "Give a chat name"}
        {(h?.wake ?? defaults.value) && ` · Wake: ${wakeLabels[h?.wake ?? defaults.value!]}`}{" "}
        {waiting ? <b>{waiting} waiting</b> : null}
      </summary>
      <form
        key={[h?.shortName, h?.wake, defaults.value].join(":")}
        className="absolute right-0 z-30 grid w-64 gap-3 rounded-md border bg-popover p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setPending(true);
          try {
            await chatRpc.run(enterprise.target, {
              kind: "threadChat",
              thread,
              settings: {
                name: String(data.get("name") ?? ""),
                wake: wakeValue(data.get("wake")),
              },
            });
            refresh((n) => n + 1);
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
          Who can wake this agent{" "}
          <select
            aria-label="Who can wake this agent"
            name="wake"
            defaultValue={h?.wake ?? defaults.value ?? "everyone"}
          >
            <WakeOptions />
          </select>
        </label>
        <button disabled={pending || (!h && !defaults.value)}>Save</button>
        {error && <span role="alert">{error}</span>}
      </form>
    </details>
  );
}

export function ThreadTimeline(props: ComponentProps<typeof Timeline>) {
  const thread = props.draftEntries === null ? props.threadDetailRef : null;
  if (!thread) return <Timeline {...props} />;
  return (
    <MemoryStrip
      key={thread.environmentId + ":" + thread.threadId}
      {...thread}
      working={props.isWorking}
      renderTimeline={(cards) => (
        <>
          <header className="flex flex-wrap items-center gap-3 text-xs">
            <ThreadToolLevels {...thread} />
            <AgentThreadHeader environmentId={thread.environmentId} thread={thread.threadId} />
            <div className="ml-auto">
              <PauseControls key={thread.environmentId} id={thread.environmentId} size="xs" />
            </div>
          </header>
          <Timeline
            {...props}
            footer={
              <>
                {props.footer}
                {cards}
                <CallApprovals {...thread} />
              </>
            }
          />
        </>
      )}
    />
  );
}
