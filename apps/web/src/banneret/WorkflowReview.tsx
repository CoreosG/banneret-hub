import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useQuietThreadShell } from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useWorkspacesStore } from "./workspacesStore";
import type { RelayTarget } from "./enrolmentStore";
import { randomUUID } from "../lib/utils";
import { chatRpc, conversations, useChatRead } from "./chat/client";

const review = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Workflow review",
  tag: "memory.workflow",
});
const needs = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Pending workflow reviews",
  tag: "memory.workflowNeeds",
});
type Action = "read" | "run" | "enable" | "disable" | "dismiss" | "setup" | "rule" | "propose";
const useWorkflowRevision = create<Record<string, number>>(() => ({}));
export async function workflowAction(ref: ScopedThreadRef, action: Action, created?: number) {
  const result = await runAtomCommand(appAtomRegistry, review, {
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId, action, ...(created === undefined ? {} : { created }) },
  });
  if (result._tag !== "Success")
    throw new Error("Could not update workflow review. Check your main orchestrator chat.");
  if (action !== "read") {
    const key = JSON.stringify([ref.environmentId, ref.threadId]);
    useWorkflowRevision.setState((s) => ({ [key]: (s[key] ?? 0) + 1 }));
  }
  return result.value;
}

type WorkflowReport = NonNullable<Awaited<ReturnType<typeof workflowAction>>["report"]>;
function CompanyDraft({ target, text }: { target: RelayTarget; text: string }) {
  const [channel, setChannel] = useState<string>();
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [status, setStatus] = useState("");
  const [key] = useState(randomUUID);
  async function click() {
    setState("busy");
    try {
      if (channel) {
        await chatRpc.run(target, { kind: "post", id: channel, text, key });
        setState("sent");
        setStatus("Sent to #feedback.");
        return;
      }
      const available = (await conversations(target)).find(
        (c) => c.kind === "channel" && c.name === "feedback" && c.me.can.post && !c.archived,
      );
      setChannel(available?.id);
      setStatus(available ? "" : "No writable #feedback channel here.");
    } catch {
      setStatus("Could not reach the feedback channel.");
    }
    setState("idle");
  }
  return (
    <>
      <button disabled={state !== "idle"} onClick={() => void click()}>
        {channel
          ? "Send draft to #feedback on " + target.relayOrigin
          : "Find company feedback channel"}
      </button>
      {status && <span role="status">{status}</span>}
    </>
  );
}
export function WorkflowResult({
  report,
  act,
  target,
  openProposal,
}: {
  report: WorkflowReport;
  openProposal?: ((key: string) => void) | undefined;
  target?: RelayTarget | undefined;
  act: (action: "dismiss" | "setup" | "rule" | "propose") => void;
}) {
  const [copied, setCopied] = useState("");
  const draft = report.reviewing
    ? null
    : report.judgment
      ? report.judgment.draft
      : report.retries
        ? {
            title: "Explain agent retries",
            body: "An agent needed to retry work. Show what caused a retry and what changed before the next attempt.",
          }
        : report.failures
          ? {
              title: "Explain failed agent tools",
              body: "An agent tool failed. Show what caused the failure and how to recover.",
            }
          : report.contested
            ? {
                title: "Help diagnose contested reminders",
                body: "A rule reminder was contested. Show why the rule was selected and how to adjust it.",
              }
            : null;
  return (
    <article
      aria-label="Workflow review result"
      className="chat-content-lane grid gap-2 rounded border p-3"
    >
      <h3>Workflow review</h3>
      {report.reviewing && <p role="status">Reviewing your workflow in the main chat.</p>}
      {report.judgment && <p>{report.judgment.summary}</p>}
      <strong>Your agents and setup</strong>
      {report.judgment?.setup && (
        <button onClick={() => act("setup")}>Propose setup change: {report.judgment.setup}</button>
      )}
      {report.judgment?.rule && (
        <button onClick={() => act("rule")}>Propose rule: {report.judgment.rule}</button>
      )}
      <p>
        {report.retries} agent retries. {report.proposed} proposed notes. {report.stale} stale
        notes.
      </p>
      <p>
        {report.fired} reminders fired, {report.acknowledged} acknowledged, {report.contested}{" "}
        contested.
      </p>
      {!report.reviewing && !report.judgment && (report.retries > 0 || report.failures > 0) && (
        <button onClick={() => act("propose")}>
          Propose a rule to diagnose failures before retrying
        </button>
      )}
      <p>
        {report.failures} failed tools or commands. {Math.round(report.waiting / 60000)} minutes
        waiting for agent approvals. {report.disputed} disputed notes. {report.corrections} repeated
        corrections.
      </p>
      {report.topRule && (
        <p>
          Most frequent reminder: {report.topRule} ({report.topCount} times).
        </p>
      )}
      {report.proposalKey && openProposal && (
        <button onClick={() => openProposal(report.proposalKey!)}>
          Review proposed note: {report.proposalKey}
        </button>
      )}
      <strong>The platform</strong>
      {draft ? (
        <>
          <h4>{draft.title}</h4>
          <p>{draft.body}</p>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(draft.title + "\n\n" + draft.body).then(
                () => setCopied("Copied."),
                () => setCopied("Could not copy."),
              )
            }
          >
            Copy draft
          </button>
          <button
            onClick={() =>
              window.open(
                "https://github.com/CoreosG/banneret-hub/issues/new?" + new URLSearchParams(draft),
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            Open draft as a public issue
          </button>
          {target && (
            <CompanyDraft
              key={JSON.stringify([target, report.created, draft])}
              target={target}
              text={draft.title + "\n\n" + draft.body}
            />
          )}
          {copied && <p role="status">{copied}</p>}
        </>
      ) : (
        !report.reviewing && <p>No platform suggestions.</p>
      )}
      {report.pending && <button onClick={() => act("dismiss")}>Mark reviewed</button>}
    </article>
  );
}
export function WorkflowReview({
  environmentId,
  threadId,
  revision = 0,
  settings = false,
  inbox = false,
  openProposal,
}: {
  revision?: number;
  settings?: boolean;
  inbox?: boolean;
  openProposal?: (key: string) => void;
} & ScopedThreadRef) {
  const ref = { environmentId, threadId };
  const thread = useQuietThreadShell(ref);
  const version = useWorkflowRevision((s) => s[JSON.stringify([environmentId, threadId])] ?? 0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const state = useChatRead(
    () => workflowAction(ref, "read"),
    [
      environmentId,
      threadId,
      revision,
      version,
      thread?.latestRun?.runId,
      thread?.latestRun?.status,
    ].join(":"),
  );
  async function act(action: Action) {
    setBusy(true);
    try {
      await workflowAction(ref, action, state.value?.report?.created);
      setStatus(["propose", "rule", "setup"].includes(action) ? "Note proposed for review." : "");
    } catch {
      setStatus("Could not apply the action. Open the current report in your main chat.");
    }
    setBusy(false);
  }
  if (inbox && !state.value?.report?.pending) return null;
  if (!state.value) return state.error && !settings ? <p role="alert">{state.error}</p> : null;
  return (
    <fieldset disabled={busy} className="grid gap-1">
      <button onClick={() => void act("run")}>Review my workflow</button>
      {settings && (
        <label>
          <input
            type="checkbox"
            checked={state.value.weekly}
            onChange={(e) => void act(e.target.checked ? "enable" : "disable")}
          />{" "}
          Weekly workflow review
        </label>
      )}
      {state.value.report && (
        <WorkflowResult
          openProposal={openProposal}
          report={state.value.report}
          target={
            state.value.relayOrigin
              ? { environmentId, relayOrigin: state.value.relayOrigin }
              : undefined
          }
          act={act}
        />
      )}
      {status && <p role="status">{status}</p>}
    </fieldset>
  );
}
function WorkflowInbox({
  environmentId,
  workspaceId,
}: {
  environmentId: EnvironmentId;
  workspaceId: string;
}) {
  const state = useChatRead(
    async () => {
      const r = await runAtomCommand(appAtomRegistry, needs, {
        environmentId,
        input: { workspaceId },
      });
      return r._tag === "Success" ? r.value : null;
    },
    JSON.stringify([environmentId, workspaceId]),
  );
  return state.value ? (
    <WorkflowReview inbox key={state.value} environmentId={environmentId} threadId={state.value} />
  ) : null;
}
export function WorkflowNeeds() {
  const id = usePrimaryEnvironmentId();
  const workspaceId = useWorkspacesStore((s) => s.activeId);
  return id && workspaceId ? (
    <WorkflowInbox
      key={JSON.stringify([id, workspaceId])}
      environmentId={id}
      workspaceId={workspaceId}
    />
  ) : null;
}
