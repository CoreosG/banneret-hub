import { EnvironmentId, ChatHandoffs, type Handoff } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { randomUUID } from "../../lib/utils";
import { useEnrolmentStore, type RelayTarget } from "../enrolmentStore";
import { useEnvironmentFeed } from "../relayFeedStore";
import { useLeaseRoute } from "../leaseMachineStore";
import { openLeaseConfirm } from "../leaseStore";
import { useTaskRead } from "../taskStore";
import type { TaskIdentity } from "../taskSurface";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { chatRpc, pageItems, useChatRead } from "./client";

const decode = Schema.decodeUnknownSync(ChatHandoffs);
export function OfferButton({ target, taskId }: { target: RelayTarget; taskId: string }) {
  const feed = useEnvironmentFeed(target);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, newKey] = useState(randomUUID);
  if (!feed.chatFlags?.includes("handoffs")) return null;
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Offer
      </Button>
    );
  return (
    <form
      className="grid gap-2 rounded border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const field = (name: string) => String(data.get(name) ?? "").trim();
        const p = feed.team?.value?.people.find((p) => p.id === field("receiver"));
        if (!p) return;
        setBusy(true);
        try {
          await chatRpc.run(target, {
            kind: "offerHandoff",
            offer: {
              taskId,
              to: { id: p.id, login: p.login },
              branch: field("branch"),
              headSha: field("head"),
              key,
              note: {
                goal: field("goal"),
                done: field("done"),
                next: field("next"),
                risks: field("risks"),
              },
            },
          });
          setOpen(false);
          newKey(randomUUID());
          setError("");
        } catch (err) {
          setError(String(err));
        }
        setBusy(false);
      }}
    >
      <label>
        Offer to{" "}
        <select required name="receiver" defaultValue="">
          <option value="">Choose a person</option>
          {feed.team?.value?.people.map((p) => (
            <option value={p.id} key={p.id}>
              {p.login}
            </option>
          ))}
        </select>
      </label>
      {["Goal", "Done", "Next", "Risks", "Branch", "Head"].map((label) => (
        <label key={label}>
          {label === "Head" ? "Full head SHA" : label}{" "}
          <input name={label.toLowerCase()} required={label !== "Risks"} />
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy} type="submit">
        Send offer
      </Button>
      <Button disabled={busy} type="button" variant="outline" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function Accept({ target, task, h }: { target: RelayTarget; task: TaskIdentity; h: Handoff }) {
  const route = useLeaseRoute(target, task);
  return (
    <Button
      disabled={route.kind !== "ready"}
      onClick={() => {
        if (route.kind === "ready")
          openLeaseConfirm({
            relay: target,
            taskId: h.taskId,
            title: task.title,
            operation: "take",
            machines: route.machines,
            chosen: route.chosen,
            handoffId: h.id,
          });
      }}
    >
      Accept
    </Button>
  );
}

function HandoffCard({
  h,
  enterprise,
  refresh,
}: {
  h: Handoff;
  enterprise: EnterpriseFeed;
  refresh: () => void;
}) {
  const { target, enrolment } = enterprise;
  const read = useTaskRead(target, h.taskId, true, null);
  const task = read.kind === "done" ? read.read?.value?.task : null;
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const giver = h.from.id === enrolment.me?.id;
  async function change(kind: "advanceHandoff" | "withdrawHandoff" | "declineHandoff") {
    setBusy(true);
    try {
      let device = target;
      const selected = giver ? h.fromMachineId : h.machineId;
      if (kind === "advanceHandoff" && selected) {
        const route = Object.entries(useEnrolmentStore.getState().views).find(([, views]) =>
          views?.some(
            (v) =>
              v.relayOrigin === target.relayOrigin &&
              v.machineId === selected &&
              v.me?.id === enrolment.me?.id,
          ),
        );
        if (!route) {
          setError("Connect the machine selected for this hand-off.");
          setBusy(false);
          return;
        }
        device = { ...target, environmentId: EnvironmentId.make(route[0]) };
      }
      await chatRpc.run(
        device,
        kind === "declineHandoff" ? { kind, id: h.id, reason } : { kind, id: h.id },
      );
      setError("");
      refresh();
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }
  return (
    <article className="grid gap-4 rounded-md border p-4 text-sm lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="grid gap-3">
        <header>
          <small>
            Hand-off offer · from {h.from.login}
            {h.fromHandle && " · written by " + h.fromHandle}
          </small>
          <h3 className="font-semibold">{task?.title ?? h.taskId}</h3>
        </header>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {Object.entries({
            Goal: h.note.goal,
            Done: h.note.done,
            Next: h.note.next,
            "Could go wrong": h.note.risks,
          })
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div className="contents" key={k}>
                <dt>{k}</dt>
                <dd className="whitespace-pre-wrap">{v}</dd>
              </div>
            ))}
          <dt>Work</dt>
          <dd>
            {h.branch && h.headSha ? (
              <>
                <code>{h.branch}</code> · pushed · <code>{h.headSha.slice(0, 12)}</code>
              </>
            ) : (
              "No branch recorded"
            )}
          </dd>
        </dl>
        <p>
          {h.state === "offered"
            ? "Offered to " +
              h.to.login +
              ". The lease stays with " +
              h.from.login +
              " until acceptance. Expires " +
              new Date(h.expiresAt).toLocaleString() +
              "."
            : h.state === "accepted"
              ? "Accepted · " +
                (h.step === "waiting_release"
                  ? "Waiting for " + h.from.login + " to release"
                  : "Waiting for " + h.to.login + " to take")
              : h.outcome === "done"
                ? "Done · held by " + h.to.login
                : h.outcome === "lost"
                  ? "Lost · " +
                    (read.kind === "done"
                      ? (read.read?.value?.lease?.holder.login ?? "another person")
                      : "another person") +
                    " claimed first"
                  : h.state + (h.reason ? " · " + h.reason : "")}
        </p>
        {h.state === "offered" && !giver && (
          <>
            <p>
              Your Hub takes the task after release and checks the claim for 10 seconds. Your
              orchestrator gets the note as data. Work runs on your usage.
            </p>
            <div className="flex gap-2">
              {task && <Accept h={h} task={task} target={target} />}
              <Button variant="outline" onClick={() => setDeclining(!declining)}>
                Decline
              </Button>
            </div>
            {declining && (
              <label>
                Reason <input value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() => void change("declineHandoff")}
                >
                  Decline offer
                </Button>
              </label>
            )}
          </>
        )}
        {giver && (h.state === "offered" || h.step === "waiting_release") && (
          <Button disabled={busy} variant="outline" onClick={() => void change("withdrawHandoff")}>
            Withdraw
          </Button>
        )}
        {h.state === "accepted" &&
          (giver ? h.step === "waiting_release" : h.step === "waiting_take") && (
            <Button disabled={busy} onClick={() => void change("advanceHandoff")}>
              {giver ? "Release now" : "Take now"}
            </Button>
          )}
        {error && <p role="alert">{error}</p>}
      </div>
      <aside className="grid content-start gap-2 rounded-md bg-muted p-3">
        {h.receipts.map((r, i) => (
          <small key={r.handle + i}>
            {r.handle} · {r.tokens} tokens · {r.seconds}s
            {r.tools.length > 0 && " · " + r.tools.join(", ")}
          </small>
        ))}
        <h4 className="font-semibold">What happens when you accept</h4>
        <ol className="list-decimal space-y-2 pl-5">
          <li>{h.to.login} accepts</li>
          <li>{h.from.login}'s Hub releases the lease</li>
          <li>{h.to.login}'s Hub takes the task and checks the claim</li>
          <li>The orchestrator receives the task and note</li>
        </ol>
        <p>
          After 30 minutes the person whose Hub is waiting gets a reminder. If someone else claims
          first, they keep the lease.
        </p>
      </aside>
    </article>
  );
}

export function HandoffCards({
  enterprise,
  id,
  threadRootId,
}: {
  enterprise: EnterpriseFeed;
  id?: string;
  threadRootId?: string;
}) {
  const [revision, setRevision] = useState(0);
  const rows = useChatRead(
    () =>
      pageItems(async (cursor) =>
        decode(
          await chatRpc.run(enterprise.target, { kind: "handoffs", ...(cursor ? { cursor } : {}) }),
        ),
      ),
    [
      enterprise.target.relayOrigin,
      enterprise.target.environmentId,
      enterprise.feed.chatRevision,
      enterprise.feed.needsFetchedAt,
      revision,
    ].join(":"),
  );
  return (
    <>
      {rows.error && <p role="alert">{rows.error}</p>}
      {rows.value
        ?.filter((h) => (id ? h.id === id : h.threadRootId === threadRootId))
        .map((h) => (
          <HandoffCard
            key={h.id}
            h={h}
            enterprise={enterprise}
            refresh={() => setRevision((n) => n + 1)}
          />
        ))}
    </>
  );
}
