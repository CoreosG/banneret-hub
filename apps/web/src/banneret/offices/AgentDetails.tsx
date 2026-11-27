import { useEffect, useRef, useState } from "react";
import type { OfficeRoomPage } from "@t3tools/contracts";
import { enrolmentRpc, type RelayTarget } from "../enrolmentStore";
import { useRoomSessions } from "./useRoomSessions";

function heardLabel(at: string, now: number) {
  const seconds = Math.floor((now - Date.parse(at)) / 1000);
  return Number.isFinite(seconds) ? "Heard " + Math.max(0, seconds) + " s ago" : "";
}

export function AgentDetails({
  session,
  target,
}: {
  session: OfficeRoomPage["sessions"][number];
  target: RelayTarget;
}) {
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState("");
  const ref = useRef<HTMLDetailsElement>(null);
  const { environmentId, relayOrigin } = target;
  const id = session.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read the heartbeat only while this expanded agent is on screen
  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    let visible = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      clearTimeout(timer);
      generation += 1;
      const version = generation;
      if (!visible || document.hidden) return;
      async function read() {
        const result = await enrolmentRpc.officeHeard({ environmentId, relayOrigin }, [id]);
        if (version !== generation) return;
        const sample = result.ok && result.value.sessions.find((s) => s.id === id);
        setHeard(
          sample && result.ok ? heardLabel(sample.heardAt, Date.parse(result.value.asOf)) : "",
        );
        timer = setTimeout(() => void read(), 15000);
      }
      void read();
    }
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      schedule();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      generation += 1;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [open, id, environmentId, relayOrigin]);
  return (
    <details ref={ref} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {session.provider} · {session.state.replaceAll("_", " ")}
      </summary>
      <p>
        {session.id}
        {session.stopReason && " · " + session.stopReason.replaceAll("_", " ")}
      </p>
      {heard && <p>{heard}</p>}
    </details>
  );
}

export function PersonRoomAgents({
  target,
  board,
  title,
  revision,
  personId,
}: {
  target: RelayTarget;
  board: string | null;
  title: string;
  revision: string | undefined;
  personId: string;
}) {
  const [open, setOpen] = useState(false);
  const { sessions, retry } = useRoomSessions(target, board, revision, open);
  const agents = sessions?.filter((s) => s.personId === personId);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Agents in {title}</summary>
      {open &&
        (agents ? (
          agents.length ? (
            agents.map((s) => <AgentDetails key={s.id} session={s} target={target} />)
          ) : (
            "No agents here."
          )
        ) : sessions === null ? (
          <button onClick={retry}>Retry agents</button>
        ) : (
          "Loading agents…"
        ))}
    </details>
  );
}
