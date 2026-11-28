import { usePause } from "../Pause";
import { personForLogin } from "./sprites";
import { toneProps } from "../ui/tokens";
import { ChatAsks, ChatHandles, ChatHandoffs, type ChatAsk } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createContext, useContext, type ReactNode } from "react";
import { chatRpc, pageItems, useChatRead } from "../chat/client";
import { askHome } from "../chat/askHome";
import type { RelayTarget } from "../enrolmentStore";
import type { EnterpriseFeed } from "../useEnterpriseFeed";

const decodeHandles = Schema.decodeUnknownSync(ChatHandles);
const decodeAsks = Schema.decodeUnknownSync(ChatAsks);
const decodeOffers = Schema.decodeUnknownSync(ChatHandoffs);
type Activity = {
  name: string;
  owner: string;
  paused: boolean;
  notes: { text: string; ask?: ChatAsk }[];
};
const empty = new Map<string, Activity>();
const Activities = createContext({ handles: empty, machines: empty });

export function OfficeActivity({
  enterprise,
  children,
}: {
  enterprise: EnterpriseFeed;
  children: ReactNode;
}) {
  const { feed, target } = enterprise;
  const flags = feed.sections.includes("chat") ? (feed.chatFlags ?? []) : [];
  if (
    !flags.includes("agents") ||
    !flags.some((f) => ["agent_asks", "reviews", "handoffs", "agent_pause"].includes(f))
  )
    return children;
  return (
    <ActiveOffice
      key={JSON.stringify([target, enterprise.enrolment.me?.id, flags])}
      enterprise={enterprise}
      flags={flags}
      revision={feed.chatRevision ?? 0}
    >
      {children}
    </ActiveOffice>
  );
}

function ActiveOffice({
  enterprise,
  flags,
  revision,
  children,
}: {
  enterprise: EnterpriseFeed;
  flags: readonly string[];
  revision: number;
  children: ReactNode;
}) {
  const { target, enrolment } = enterprise;
  const locallyPaused =
    usePause((s) => s[target.environmentId]?.status?.paused === true) &&
    flags.includes("agent_pause");
  const rows = useChatRead(async () => {
    const [agents, questions, offers] = await Promise.all([
      pageItems(async (cursor) =>
        decodeHandles(await chatRpc.run(target, { kind: "handles", ...(cursor && { cursor }) })),
      ),
      flags.includes("agent_asks") || flags.includes("reviews")
        ? Promise.all(
            (["waiting_owner", "open", "draft"] as const).map((state) =>
              pageItems(async (cursor) =>
                decodeAsks(
                  await chatRpc.run(target, {
                    kind: "officeAsks",
                    state,
                    ...(cursor && { cursor }),
                  }),
                ),
              ),
            ),
          ).then((pages) => pages.flat())
        : [],
      flags.includes("handoffs")
        ? pageItems(async (cursor) =>
            decodeOffers(
              await chatRpc.run(target, { kind: "handoffs", ...(cursor && { cursor }) }),
            ),
          )
        : [],
    ]);
    const byId = new Map<string, Activity>(
      agents.map((h) => [
        h.id,
        {
          name: h.owner.login + "/" + (h.shortName ?? h.claimName),
          owner: h.owner.id,
          paused: flags.includes("agent_pause") && h.paused,
          notes: [],
        },
      ]),
    );
    for (const ask of questions) {
      if (
        ask.to.kind !== "agent" ||
        !flags.includes(ask.kind === "review" ? "reviews" : "agent_asks")
      )
        continue;
      const from = byId.get(ask.from.handle),
        to = byId.get(ask.to.handle);
      if (!from || !to) continue;
      from.notes.push({ text: "asking " + to.name, ask });
      if (ask.state === "open") to.notes.push({ text: "answering " + from.name, ask });
    }
    for (const offer of offers) {
      if (offer.fromHandle && (offer.state === "offered" || offer.state === "accepted"))
        byId.get(offer.fromHandle)?.notes.push({ text: "pending hand-off" });
    }
    return { byId, agents };
  }, revision);
  const handles = new Map<string, Activity>(),
    machines = new Map<string, Activity>();
  if (!rows.error && rows.value) {
    for (const h of rows.value.agents) {
      const row = rows.value.byId.get(h.id)!;
      const paused = row.paused || (locallyPaused && enrolment.machineId === h.machine.id);
      if (paused || row.notes.length) handles.set(row.name, { ...row, paused });
      if (paused)
        machines.set(h.machine.id, {
          name: h.machine.label,
          owner: h.owner.id,
          paused: true,
          notes: [],
        });
    }
  }
  if (locallyPaused && enrolment.machineId && enrolment.me)
    machines.set(enrolment.machineId, {
      name: enrolment.label ?? "This machine",
      owner: enrolment.me.id,
      paused: true,
      notes: [],
    });
  return <Activities.Provider value={{ handles, machines }}>{children}</Activities.Provider>;
}

export function useAgentActivity() {
  const { handles, machines } = useContext(Activities);
  return (agent: { handle?: string | undefined; machineId?: string | undefined }) =>
    handles.get(agent.handle ?? "") ?? machines.get(agent.machineId ?? "");
}
export function activityText(activity: Activity) {
  return [
    ...new Set(activity.notes.map((n) => n.text)),
    ...(activity.paused ? ["paused"] : []),
  ].join(" · ");
}
export function ListActivity({ owner }: { owner: string }) {
  const { handles, machines } = useContext(Activities);
  const activities = [...handles.values()].filter((a) => a.owner === owner);
  if (!activities.some((a) => a.paused))
    activities.push(...[...machines.values()].filter((a) => a.owner === owner));
  return activities.length ? (
    <span className="max-h-full min-w-0 overflow-auto text-xs">
      {activities.map((a) => (
        <span className="block whitespace-nowrap" key={a.name}>
          {a.name} · {activityText(a)}
        </span>
      ))}
    </span>
  ) : null;
}

export function RobotActivity({ activity }: { activity: Activity }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute bottom-full left-1/2 grid w-max max-w-44 -translate-x-1/2 justify-items-center gap-px"
    >
      {[...new Map(activity.notes.map((n) => [n.text, n.ask?.from.owner.login])).entries()].map(
        ([text, login]) => {
          const person = login && personForLogin(login);
          return (
            <span
              key={text}
              {...(person && person.kind === "person" && toneProps(person.coat, "edge", "fg"))}
              className="max-w-full truncate rounded-md border bg-popover px-1.5 text-3xs text-popover-foreground shadow-sm"
            >
              {text}
            </span>
          );
        },
      )}
      {activity.paused && (
        <span
          {...toneProps("warn", "fg", "edge")}
          className="rounded border bg-card px-2 text-3xs font-semibold"
        >
          paused
        </span>
      )}
    </span>
  );
}

export function OfficeAskLink({ ask, target }: { ask: ChatAsk; target: RelayTarget }) {
  const home = useChatRead(() => askHome(target, ask, []), ask.id);
  return (
    <p>
      {home.value ? (
        <a className="underline" href={home.value.href}>
          {ask.question}
        </a>
      ) : (
        ask.question
      )}
    </p>
  );
}
