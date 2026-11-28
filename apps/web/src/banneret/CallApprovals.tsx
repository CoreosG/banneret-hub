import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { CallApproval, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { toastManager } from "../components/ui/toast";
import { Button } from "../components/ui/button";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";

const feed = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "Local call approvals",
  tag: "plugins.approvals",
});
const decision = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Decide exact call",
  tag: "plugins.decide",
});
type Choice = "once" | "always" | "refuse";
export function CallApprovalCard({
  call,
  decide,
}: {
  call: CallApproval;
  decide: (choice: Choice, reason: string) => Promise<CallApproval>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<CallApproval>();
  const [problem, setProblem] = useState("");
  const shown = call.state === "pending" ? (answer ?? call) : call;
  async function choose(choice: Choice) {
    setBusy(true);
    setProblem("");
    try {
      setAnswer(await decide(choice, reason));
    } catch {
      setProblem("Could not save your decision.");
    }
    setBusy(false);
  }
  return (
    <section
      aria-label="Exact call approval"
      className="my-2 grid gap-2 rounded-lg border border-warning/40 bg-card p-3 text-sm"
    >
      <header className="flex items-center gap-2">
        <KeyRoundIcon className="size-4 text-warning" />
        <strong>Approve this exact call?</strong>
        <span className="ml-auto text-xs">
          {shown.state === "pending" ? "Waiting for you" : shown.state}
        </span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        <dt>Thread</dt>
        <dd>{call.threadTitle}</dd>
        <dt>Source</dt>
        <dd>
          {call.source === "banneret" ? "Banneret tools" : call.source.replace(/^plugin:/, "")}
        </dd>
        <dt>Tool</dt>
        <dd>
          <code>{call.name}</code>{" "}
          <span className="text-xs text-warning">{call.sensitive ? "sensitive" : "write"}</span>
        </dd>
      </dl>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
        {JSON.stringify(JSON.parse(call.args), null, 2)}
      </pre>
      {shown.state === "pending" ? (
        <>
          <p className="text-xs text-muted-foreground">
            Call <code>{call.id.slice(0, 8)}</code>. If you approve, the Hub runs this stored call.
          </p>
          {!call.allowAlways && (
            <p className="text-xs">
              {call.sensitive
                ? "This destructive tool needs approval every time."
                : "Only a turn started by its owner can save an always-allow rule."}
            </p>
          )}
          <label>
            Reason for refusal
            <input
              className="ml-2 rounded border px-2"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void choose("once")}>
              Approve once
            </Button>
            {call.allowAlways && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void choose("always")}
              >
                Always allow this tool for this thread
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !reason.trim()}
              onClick={() => void choose("refuse")}
            >
              Refuse
            </Button>
          </div>
        </>
      ) : (
        <p role="status">
          {shown.state === "unknown"
            ? "The call may or may not have run."
            : shown.state === "expired"
              ? "The approval expired."
              : shown.state === "refused"
                ? "Refused"
                : "Decision saved"}
          {shown.actor && " by " + shown.actor}
          {shown.reason && ". " + shown.reason}
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}
export function CallApprovals({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
}) {
  const result = useAtomValue(feed({ environmentId, input: threadId ? { threadId } : {} }));
  if (result._tag !== "Success") return null;
  return (
    <>
      {result.value.map((call) => (
        <CallApprovalCard
          key={call.id}
          call={call}
          decide={async (choice, reason) => {
            const reply = await runAtomCommand(appAtomRegistry, decision, {
              environmentId,
              input: { id: call.id, choice, reason },
            });
            if (reply._tag !== "Success") throw new Error("Decision failed.");
            if (!threadId)
              toastManager.add({
                type: "info",
                title: reply.value.actor
                  ? "Decided by " + reply.value.actor
                  : "Call " + reply.value.state,
                description: call.name,
              });
            return reply.value;
          }}
        />
      ))}
    </>
  );
}
export function LocalCallApprovals() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <CallApprovals environmentId={environmentId} /> : null;
}
