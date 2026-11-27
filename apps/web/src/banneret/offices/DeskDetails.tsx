import type {
  BanneretTeam,
  BanneretBoardCard,
  OfficeRoomPage,
  OfficeSummary,
  PoolResources,
} from "@t3tools/contracts";
import { useState } from "react";
import type { RelayTarget } from "../enrolmentStore";
import { MachineResources } from "../ui/MachineResources";
import { LeaseChip } from "../ui/Chips";
import { toneProps } from "../ui/tokens";
import { AgentDetails } from "./AgentDetails";
import { useOpenTask } from "../useOpenTask";
type Person = BanneretTeam["people"][number];
type Counts = OfficeSummary["hallway"]["counts"];
export const labels = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  notHeardFrom: "Not heard from",
  stopped: "Stopped",
};
export const states = Object.keys(labels) as (keyof Counts)[];
function SharedMachine({
  machine,
  owner,
  target,
  pool,
  visible,
}: {
  machine: Person["machines"][number];
  owner: string;
  target: RelayTarget;
  pool: PoolResources | null;
  visible: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="text-xs text-muted-foreground"
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary className="cursor-pointer">{machine.label}</summary>
      {expanded && visible && (
        <MachineResources
          target={target}
          machineId={machine.id}
          hostId={machine.poolHostId}
          owner={owner}
          pool={pool}
        />
      )}
    </details>
  );
}
export function AgentCounts({ counts }: { counts: Counts | undefined }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {states
        .filter((k) => counts?.[k])
        .map((k) => (
          <span
            key={k}
            className="rounded-full px-2 py-0.5 text-xs"
            {...toneProps(
              k === "waiting" ? "warn" : k === "working" ? "ok" : "muted",
              "tint",
              "fg",
            )}
          >
            {counts?.[k]} {labels[k].toLowerCase()}
          </span>
        ))}
    </span>
  );
}

export function Claims({
  cards,
  login,
  target,
}: {
  cards: readonly BanneretBoardCard[];
  login: string;
  target: RelayTarget;
}) {
  const openTask = useOpenTask(target);
  return (
    <>
      {cards.map(
        (card) =>
          card.lease && (
            <button
              key={card.task.id}
              className="flex items-center gap-1 hover:underline"
              onClick={() => openTask(card.task)}
            >
              {card.task.title}
              <LeaseChip
                holder={card.lease.claim ?? login + "/private"}
                state={["active", "paused"].includes(card.lease.state) ? card.lease.state : "stale"}
                staleAt={card.lease.staleAt}
              />
            </button>
          ),
      )}
    </>
  );
}
export function DeskDetails({
  p,
  counts,
  agents,
  cards,
  flags,
  target,
  visible,
  pool,
}: {
  p: Person;
  counts: Counts | undefined;
  agents: OfficeRoomPage["sessions"];
  cards: readonly BanneretBoardCard[];
  flags: readonly string[];
  target: RelayTarget;
  visible: boolean;
  pool: PoolResources | null;
}) {
  return (
    <>
      <strong>{p.displayName ?? p.login}</strong>
      {flags.includes("presence") && (
        <span className="ml-2 text-muted-foreground">{p.presence}</span>
      )}
      {flags.includes("status") && p.status && <p>{p.status.text}</p>}
      <div className="my-1">
        <AgentCounts counts={counts} />
      </div>
      {agents.map((session) => (
        <AgentDetails key={session.id} session={session} target={target} />
      ))}
      {flags.includes("sharing") &&
        p.machines.map((m) => (
          <SharedMachine
            key={m.id}
            machine={m}
            owner={p.login}
            target={target}
            visible={visible}
            pool={pool}
          />
        ))}
      <Claims cards={cards} login={p.login} target={target} />
    </>
  );
}
