// Banneret Hub: Take, Release, Finish and Withdraw for one task, the Release dialog, and the line that
// says how the last change went. Every button follows the server's `leases.check` answer; nothing here
// decides who may do what.
import type { EnvironmentId, IssueRef, TaskLeaseStatus } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import {
  chooseReason,
  emptyReleaseForm,
  NOTE_MAX_BYTES,
  noteBytes,
  OTHER_TEXT_MAX,
  otherTextLength,
  RELEASE_REASON_OPTIONS,
  releaseFormProblem,
  releaseInput,
  type ReleaseForm,
} from "./lease.logic";
import "./lease.css";
import {
  checkLease,
  openReleaseDialog,
  runLease,
  useLeaseEntry,
  useReleaseDialogStore,
  type LeaseEntry,
  type LeaseOperation,
} from "./leaseStore";
import { toneProps } from "./ui/tokens";

const RUNNING_WORDS: Readonly<Record<LeaseOperation, string>> = {
  take: "Taking… confirming who claimed first.",
  release: "Releasing…",
  finish: "Finishing…",
  withdraw: "Withdrawing…",
};

/** Reads the lease when the task is shown; the tracker may have changed since the last read. */
export function useLeaseCheck(
  environmentId: EnvironmentId,
  taskId: string,
  ref: IssueRef | null,
  enabled: boolean,
): LeaseEntry | undefined {
  const entry = useLeaseEntry(environmentId, taskId);
  // Compared field by field: a new object for the same issue must not read again.
  const projectId = ref?.projectId ?? null;
  const tracker = ref?.tracker ?? null;
  const host = ref?.host;
  const scope = ref?.scope ?? "";
  const key = ref?.key ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the tracker's lease when the task is shown
  useEffect(() => {
    if (!enabled || projectId === null || tracker === null) return;
    void checkLease(environmentId, taskId, {
      projectId,
      tracker,
      ...(host === undefined ? {} : { host }),
      scope,
      key,
    });
  }, [environmentId, taskId, enabled, projectId, tracker, host, scope, key]);
  return entry;
}

/** The status shown with the controls: the check's own one-line reason when take and release are off. */
function unavailableLine(status: TaskLeaseStatus): string | null {
  if (status.availability === "available") return null;
  return status.detail ?? "Take and release are off for this task.";
}

/** What the person should know about the lease beyond the buttons, or null. */
function situationLine(status: TaskLeaseStatus): string | null {
  const lease = status.lease;
  const viewer = status.viewer?.toLowerCase() ?? "";
  if (lease === null || viewer === "") return null;
  const mine = (login: string) => login.toLowerCase() === viewer;
  if (lease.state === "conflict" && !mine(lease.holder) && lease.claimants.some(mine)) {
    return `${lease.holder} took it first. Withdraw your claim.`;
  }
  if (lease.state === "incomplete" && mine(lease.holder)) {
    return "Your last take or release stopped half way. Finish it, or Withdraw.";
  }
  return null;
}

/** The buttons for the task header. Nothing shows until the check answers. */
export function LeaseButtons(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly title: string;
  readonly issueRef: IssueRef;
  readonly entry: LeaseEntry | undefined;
  /** The last holder left notes for whoever continues: Take reads "Continue". */
  readonly continues: boolean;
}) {
  const { entry, issueRef } = props;
  const status = entry?.status ?? null;
  if (status === null) return null;
  const running = entry?.phase.kind === "running" ? entry.phase.operation : null;
  const disabled = running !== null || status.busy;
  const run = (operation: LeaseOperation) =>
    void runLease(props.environmentId, props.taskId, issueRef, operation);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="lease-buttons">
      {status.actions.take ? (
        <Button size="sm" disabled={disabled} onClick={() => run("take")}>
          {running === "take" ? "Taking…" : props.continues ? "Continue" : "Take"}
        </Button>
      ) : null}
      {status.actions.release ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            openReleaseDialog({
              environmentId: props.environmentId,
              taskId: props.taskId,
              title: props.title,
              ref: issueRef,
            })
          }
        >
          {running === "release" ? "Releasing…" : "Release…"}
        </Button>
      ) : null}
      {status.actions.finish ? (
        <Button size="sm" disabled={disabled} onClick={() => run("finish")}>
          {running === "finish" ? "Finishing…" : "Finish"}
        </Button>
      ) : null}
      {status.actions.withdraw ? (
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => run("withdraw")}>
          {running === "withdraw" ? "Withdrawing…" : "Withdraw"}
        </Button>
      ) : null}
    </div>
  );
}

/** A one-shot bar over the 10 s read-back; it runs once and stops, so it never repaints forever. */
function ReadBackBar() {
  return (
    <span
      aria-hidden
      data-slot="read-back-bar"
      className="block h-1 w-full overflow-hidden rounded-full bg-accent"
    >
      <span
        className="block h-full w-full origin-left rounded-full bg-primary"
        data-lease-readback
      />
    </span>
  );
}

/** How the last change went, what is running, or why take and release are off. */
export function LeaseNoticeLine(props: {
  readonly entry: LeaseEntry | undefined;
  readonly className?: string;
}) {
  const entry = props.entry;
  if (entry === undefined) return null;
  if (entry.phase.kind === "running") {
    return (
      <div
        role="status"
        data-testid="lease-progress"
        data-operation={entry.phase.operation}
        className={cn("flex flex-col gap-1 text-muted-foreground text-xs", props.className)}
      >
        <span>{RUNNING_WORDS[entry.phase.operation]}</span>
        {entry.phase.operation === "take" ? <ReadBackBar /> : null}
      </div>
    );
  }
  const status = entry.status;
  const lines: Array<{
    readonly key: string;
    readonly text: string;
    readonly tone: "ok" | "warn" | "error" | "muted";
  }> = [];
  if (entry.notice !== null) {
    lines.push({ key: "notice", text: entry.notice.message, tone: entry.notice.tone });
  }
  if (status !== null) {
    const situation = situationLine(status);
    if (situation !== null && situation !== entry.notice?.message) {
      lines.push({ key: "situation", text: situation, tone: "warn" });
    }
    if (status.busy && entry.phase.kind === "settled") {
      lines.push({
        key: "busy",
        text: "Another change to this task is running on this server.",
        tone: "muted",
      });
    }
    const unavailable = unavailableLine(status);
    if (unavailable !== null) lines.push({ key: "off", text: unavailable, tone: "muted" });
  }
  if (lines.length === 0) return null;
  return (
    <div
      className={cn("flex flex-col gap-0.5 text-xs", props.className)}
      data-testid="lease-notice"
    >
      {lines.map((line) => (
        <p
          key={line.key}
          role={line.tone === "error" ? "alert" : "status"}
          data-lease-line={line.key}
          className={cn("break-words", line.tone === "muted" && "text-muted-foreground")}
          {...(line.tone === "muted" ? {} : toneProps(line.tone, "fg"))}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}

function Counter(props: { readonly used: number; readonly max: number; readonly unit: string }) {
  const over = props.used > props.max;
  return (
    <span
      data-testid={`counter-${props.unit}`}
      className={cn("tabular-nums text-xs", over ? undefined : "text-muted-foreground")}
      {...(over ? toneProps("error", "fg") : {})}
    >
      {props.used} / {props.max} {props.unit}
    </span>
  );
}

function ReleaseFormBody(props: {
  readonly form: ReleaseForm;
  readonly onChange: (form: ReleaseForm) => void;
}) {
  const id = useId();
  const { form } = props;
  const set = (patch: Partial<ReleaseForm>) => props.onChange({ ...form, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium text-sm">Reason</legend>
        <RadioGroup
          aria-label="Reason"
          value={form.reason ?? ""}
          onValueChange={(value) => {
            const option = RELEASE_REASON_OPTIONS.find((candidate) => candidate.id === value);
            if (option !== undefined) props.onChange(chooseReason(form, option.id));
          }}
        >
          {RELEASE_REASON_OPTIONS.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <Radio value={option.id} />
              {option.label}
            </label>
          ))}
        </RadioGroup>
        {form.reason === "other" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-other`}>Why</Label>
            <Input
              id={`${id}-other`}
              value={form.otherText}
              placeholder="One line, for example: not needed after the redesign"
              onChange={(event) => set({ otherText: event.target.value.replace(/[\r\n]/g, " ") })}
            />
            <Counter
              used={otherTextLength(form.otherText)}
              max={OTHER_TEXT_MAX}
              unit="characters"
            />
          </div>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium text-sm">Note for whoever continues (optional)</legend>
        {(
          [
            ["goal", "Goal"],
            ["done", "Done"],
            ["next", "Next"],
          ] as const
        ).map(([field, label]) => (
          <div key={field} className="grid grid-cols-[48px_1fr] items-start gap-2">
            <span className="pt-1.5">
              <Label htmlFor={`${id}-${field}`}>{label}</Label>
            </span>
            <Textarea
              id={`${id}-${field}`}
              rows={1}
              value={form[field]}
              onChange={(event) => set({ [field]: event.target.value })}
            />
          </div>
        ))}
        <span className="self-end">
          <Counter used={noteBytes(form)} max={NOTE_MAX_BYTES} unit="bytes" />
        </span>
      </fieldset>
      <label className="flex items-start gap-3">
        <Switch
          checked={form.freeToContinue}
          onCheckedChange={(checked) => set({ freeToContinue: checked })}
          aria-label="Free to continue"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm">Free to continue</span>
          <span className="text-muted-foreground text-xs">
            Shows this task at the top of Free, with your note, for anyone to pick up.
          </span>
        </span>
      </label>
    </div>
  );
}

/** The Release dialog for the task in `useReleaseDialogStore`. Mounted once, beside the Task dialog. */
export function ReleaseDialogHost() {
  const target = useReleaseDialogStore((state) => state.target);
  if (target === null) return null;
  return <ReleaseDialog key={`${target.environmentId}\u0000${target.taskId}`} />;
}

function ReleaseDialog() {
  const target = useReleaseDialogStore((state) => state.target)!;
  const entry = useLeaseEntry(target.environmentId, target.taskId);
  const [form, setForm] = useState<ReleaseForm>(emptyReleaseForm);
  const [failure, setFailure] = useState<string | null>(null);
  const running = entry?.phase.kind === "running";
  const problem = releaseFormProblem(form);
  const send = async () => {
    if (form.reason === null || problem !== null) return;
    setFailure(null);
    const answer = await runLease(
      target.environmentId,
      target.taskId,
      target.ref,
      "release",
      releaseInput({ ...form, reason: form.reason }),
    );
    if (answer.ok) openReleaseDialog(null);
    else setFailure(answer.message);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) openReleaseDialog(null);
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="release-dialog">
        <DialogHeader>
          <DialogTitle>Release task</DialogTitle>
          <DialogDescription className="break-words">{target.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ReleaseFormBody form={form} onChange={setForm} />
          {failure === null ? null : (
            <p role="alert" className="mt-3 text-xs" {...toneProps("error", "fg")}>
              {failure}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <span
            className="me-auto self-center text-muted-foreground text-xs"
            data-testid="release-problem"
          >
            {form.reason === null ? "" : (problem ?? "")}
          </span>
          <Button variant="outline" disabled={running} onClick={() => openReleaseDialog(null)}>
            Cancel
          </Button>
          <Button disabled={running || problem !== null} onClick={() => void send()}>
            {running ? "Releasing…" : "Release"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
