// Banneret Hub: join this machine to a company relay: address, "Join <company>", the sign-in code,
// then the company's projects. One enrolment per relay, so a new join always starts at the address
// and a relay already joined opens its workspace. Shows only what `status` says about that relay.
import type { BanneretEnrolmentView, BanneretMachineKind, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";

import { Button } from "../components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import {
  canForget,
  canJoinAgain,
  countdown,
  forgetNotice,
  healthLine,
  isValidMachineLabel,
  joinAgainNotice,
  joinDetails,
  lastResultMessage,
  letterAvatar,
  machineLabelFrom,
  remoteUrlsOf,
  revokedMessage,
  connectedLine,
  wizardStep,
} from "./enterprise.logic";
import {
  enrolmentRpc,
  type RelayOutcome,
  type RelayTarget,
  refreshEnrolment,
  storeEnrolmentView,
  useEnrolmentMachine,
  useEnrolmentView,
} from "./enrolmentStore";
import { deleteWorkspace } from "./workspaces.logic";
import {
  ownerOfGroup,
  ProjectChecklist,
  usePickableProjectGroups,
  WorkspaceKindChoice,
  workspaceWithProjects,
} from "./WorkspaceProjectPicker";
import {
  loadEnvironmentWorkspaces,
  saveWorkspaces,
  setActiveWorkspace,
  useWorkspaces,
} from "./workspacesStore";

const MACHINE_KINDS: ReadonlyArray<{ readonly kind: BanneretMachineKind; readonly label: string }> =
  [
    { kind: "laptop", label: "Laptop" },
    { kind: "desktop", label: "Desktop" },
    { kind: "server", label: "Server" },
    { kind: "cloud", label: "Cloud" },
  ];

/** Opens the relay's sign-in page in the system browser; the server may be a headless remote. */
function openSignIn(url: string | undefined) {
  if (url === undefined) return;
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch(() => undefined);
}

function CompanyAvatar(props: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary font-semibold text-secondary-foreground"
    >
      {letterAvatar(props.name)}
    </span>
  );
}

/** A relay this machine is already joining or has joined: its progress, not a second join. */
const alreadyJoined = (view: BanneretEnrolmentView | undefined) =>
  view !== undefined && view.state !== "none" && view.state !== "revoked" && !canJoinAgain(view);

function JoinForm(props: {
  readonly environmentId: EnvironmentId;
  readonly initialOrigin: string | undefined;
  readonly notice: string | null;
  /** The relay this form joins or found already joined; the wizard then follows that relay. */
  readonly onRelay: (origin: string) => void;
}) {
  const id = useId();
  const environments = useEnvironmentIdentities();
  const environmentLabel =
    environments.find((entry) => entry.environmentId === props.environmentId)?.label ?? "";
  const [address, setAddress] = useState(props.initialOrigin ?? "");
  const [relay, setRelay] = useState<{ origin: string; displayName: string } | null>(null);
  const [label, setLabel] = useState(() => machineLabelFrom(environmentLabel));
  const [kind, setKind] = useState<BanneretMachineKind>("laptop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The previous attempt's result shows only until this form starts a new one.
  const [attempted, setAttempted] = useState(false);
  // The company this address belongs to, when this machine has joined it already.
  const [joinedAlready, setJoinedAlready] = useState<string | null>(null);

  const check = async () => {
    setAttempted(true);
    setBusy(true);
    setError(null);
    setJoinedAlready(null);
    const result = await enrolmentRpc.probe(props.environmentId, address);
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    const views = await refreshEnrolment(props.environmentId);
    setBusy(false);
    const existing = views?.find((view) => view.relayOrigin === result.value.origin);
    if (existing !== undefined && alreadyJoined(existing)) {
      // Joined already: say so and open that company's workspace; joining: show where it stands.
      if (existing.state === "configured") {
        setActiveWorkspace(existing.workspaceId);
        setJoinedAlready(existing.displayName ?? result.value.displayName);
      } else props.onRelay(existing.relayOrigin);
      return;
    }
    setRelay(result.value);
  };
  const join = async () => {
    if (relay === null) return;
    setAttempted(true);
    setBusy(true);
    setError(null);
    const result = await enrolmentRpc.start(props.environmentId, {
      origin: relay.origin,
      label: label.trim(),
      kind,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    storeEnrolmentView(props.environmentId, result.value);
    props.onRelay(result.value.relayOrigin);
    openSignIn(result.value.browserUrl);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void (relay === null ? check() : join());
      }}
    >
      {props.notice !== null && !attempted ? (
        <p role="status" className="text-muted-foreground text-sm">
          {props.notice}
        </p>
      ) : null}
      {relay === null ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-address`}>Relay address</Label>
          <Input
            id={`${id}-address`}
            value={address}
            placeholder="relay.example.com"
            autoComplete="off"
            autoFocus
            onChange={(event) => setAddress(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Your company gives you this address. It must use https.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <CompanyAvatar name={relay.displayName} />
            <div className="min-w-0">
              <p className="truncate font-medium text-sm">Join {relay.displayName}</p>
              <p className="truncate text-muted-foreground text-xs">{relay.origin}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-label`}>Name for this machine</Label>
            <Input
              id={`${id}-label`}
              value={label}
              maxLength={64}
              autoComplete="off"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Machine type">
            {MACHINE_KINDS.map((entry) => (
              <Button
                key={entry.kind}
                size="xs"
                type="button"
                variant={entry.kind === kind ? "secondary" : "ghost"}
                aria-pressed={entry.kind === kind}
                onClick={() => setKind(entry.kind)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
        </>
      )}
      {error !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {joinedAlready !== null ? (
        <p role="status" className="text-sm">
          This machine has already joined {joinedAlready}. Its workspace is now open.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {relay !== null ? (
          <Button type="button" variant="outline" onClick={() => setRelay(null)}>
            Back
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={
            busy || (relay === null ? address.trim().length === 0 : !isValidMachineLabel(label))
          }
        >
          {relay === null ? "Continue" : `Join ${relay.displayName}`}
        </Button>
      </div>
    </form>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a once-a-second countdown of the code's expiry
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A quiet link that copies what support needs to find this join in the relay's `pairings list`. */
function CopyDetails(props: {
  readonly target: RelayTarget;
  readonly view: BanneretEnrolmentView;
}) {
  const machine = useEnrolmentMachine(props.target.environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("join details"),
  });
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size="compact"
      className="me-auto"
      onClick={() => copyToClipboard(joinDetails(props.view, machine), undefined)}
    >
      {isCopied ? "Copied" : "Copy details"}
    </Button>
  );
}

function CodeStep(props: { readonly target: RelayTarget; readonly view: BanneretEnrolmentView }) {
  const now = useNow(1000);
  const awaiting = props.view.state === "awaiting_approval";
  const cancel = async () => {
    const result = await enrolmentRpc.cancel(props.target);
    if (result.ok) storeEnrolmentView(props.target.environmentId, result.value);
    else void refreshEnrolment(props.target.environmentId);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <CompanyAvatar name={props.view.displayName ?? ""} />
        <p className="min-w-0 truncate font-medium text-sm">Join {props.view.displayName}</p>
      </div>
      {awaiting ? (
        <p role="status" className="text-sm">
          Waiting for a founder to approve (until{" "}
          {props.view.expiresAt ? new Date(props.view.expiresAt).toLocaleDateString() : "later"}).
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Sign in on {props.view.displayName}'s page, then type this code there.
          </p>
          <p
            aria-label="Confirm code"
            className="select-all text-center font-mono font-semibold text-3xl tracking-widest"
          >
            {props.view.confirmCode}
          </p>
          <p className="text-center text-muted-foreground text-xs">
            Expires in {countdown(props.view.expiresAt, now)}
          </p>
        </>
      )}
      <div className="flex justify-end gap-2">
        <CopyDetails target={props.target} view={props.view} />
        <Button type="button" variant="outline" onClick={() => void cancel()}>
          Cancel
        </Button>
        {awaiting ? null : (
          <Button type="button" onClick={() => openSignIn(props.view.browserUrl)}>
            Open sign-in page
          </Button>
        )}
      </div>
    </div>
  );
}

/** Approved, setting up. If setup keeps failing, the person can still cancel or forget. */
function FinishingStep(props: {
  readonly target: RelayTarget;
  readonly view: BanneretEnrolmentView;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = props.view.health === undefined ? null : healthLine(props.view).text;
  const notice = forgetNotice(props.view);
  const act = async (run: () => Promise<RelayOutcome<BanneretEnrolmentView>>) => {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (result.ok) storeEnrolmentView(props.target.environmentId, result.value);
    else {
      setError(result.message);
      void refreshEnrolment(props.target.environmentId);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <CompanyAvatar name={props.view.displayName ?? ""} />
        <p className="min-w-0 truncate font-medium text-sm">Join {props.view.displayName}</p>
      </div>
      <p role="status" className="text-sm">
        Finishing setup…
      </p>
      {line !== null ? <p className="text-muted-foreground text-sm">{line}</p> : null}
      {notice !== null ? <p className="text-muted-foreground text-sm">{notice}</p> : null}
      {error !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <CopyDetails target={props.target} view={props.view} />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => enrolmentRpc.cancel(props.target))}
        >
          Cancel
        </Button>
        {canForget(props.view) ? (
          <Button
            type="button"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void act(() => enrolmentRpc.leave(props.target, "forget"))}
          >
            Forget this machine here
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProjectStep(props: {
  readonly target: RelayTarget;
  readonly view: BanneretEnrolmentView;
  readonly onClose: () => void;
}) {
  const workspaces = useWorkspaces();
  const groups = usePickableProjectGroups();
  const workspace = workspaces.find((entry) => entry.id === props.view.workspaceId) ?? null;
  const [matched, setMatched] = useState<ReadonlySet<string> | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const remoteUrls = remoteUrlsOf(groups.flatMap((group) => group.memberProjects));
  const remoteKey = remoteUrls.join("\n");
  const { environmentId, relayOrigin } = props.target;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the workspace the server just wrote and the company's repository list once joined
  useEffect(() => {
    void loadEnvironmentWorkspaces(environmentId);
    let current = true;
    void enrolmentRpc
      .matchProjects({ environmentId, relayOrigin }, remoteKey === "" ? [] : remoteKey.split("\n"))
      .then((result) => {
        if (current) setMatched(new Set(result.ok ? result.value.matched : []));
      });
    return () => {
      current = false;
    };
  }, [environmentId, relayOrigin, remoteKey]);

  const preselected = new Set(
    groups
      .filter(
        (group) =>
          (workspace !== null && ownerOfGroup(group, workspaces) === workspace.id) ||
          group.memberProjects.some(
            (project) =>
              project.repositoryIdentity != null &&
              matched?.has(project.repositoryIdentity.locator.remoteUrl) === true,
          ),
      )
      .map((group) => group.projectKey),
  );
  const selection = picked ?? preselected;

  const save = () => {
    if (workspace === null) return;
    void saveWorkspaces(
      workspaceWithProjects({
        workspaces,
        workspace,
        groups,
        selection,
        now: new Date().toISOString(),
      }),
    );
    setActiveWorkspace(workspace.id);
    props.onClose();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <CompanyAvatar name={props.view.displayName ?? ""} />
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">
            <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-success" />
            {connectedLine(props.view.me)}
          </p>
          {props.view.replacedLabel !== undefined ? (
            <p className="truncate text-muted-foreground text-xs">
              This replaced {props.view.replacedLabel}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="font-medium text-sm">Projects</span>
        <p className="text-muted-foreground text-xs">
          {matched === null
            ? "Checking which projects belong to the company…"
            : matched.size > 0
              ? `Ticked: projects in ${props.view.displayName}'s repository list.`
              : `Pick the projects that belong to ${props.view.displayName}.`}
        </p>
        <ProjectChecklist
          groups={groups}
          workspaces={workspaces}
          editingId={workspace?.id ?? null}
          selection={selection}
          onToggle={(projectKey, checked) => {
            const next = new Set(selection);
            if (checked) next.add(projectKey);
            else next.delete(projectKey);
            setPicked(next);
          }}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={props.onClose}>
          Later
        </Button>
        <Button type="button" disabled={workspace === null} onClick={save}>
          Save projects
        </Button>
      </div>
    </div>
  );
}

function RevokedStep(props: {
  readonly view: BanneretEnrolmentView;
  readonly onJoinAgain: () => void;
  readonly onClose: () => void;
}) {
  const workspaces = useWorkspaces();
  const workspace = workspaces.find((entry) => entry.id === props.view.workspaceId) ?? null;
  const remove = () => {
    if (workspace !== null) {
      void saveWorkspaces([deleteWorkspace(workspace, new Date().toISOString())]);
    }
    props.onClose();
  };
  return (
    <div className="flex flex-col gap-4">
      <p role="alert" className="text-destructive text-sm">
        {revokedMessage(props.view)}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="destructive-outline" onClick={remove}>
          Remove workspace
        </Button>
        <Button type="button" onClick={props.onJoinAgain}>
          Join again
        </Button>
      </div>
    </div>
  );
}

export function EnterpriseWizard(props: {
  /** The relay to show, from a workspace's "Join on this machine"; none for a new join. */
  readonly initialOrigin: string | undefined;
  readonly onClose: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  // The relay this wizard follows: none until the address is checked, so a new join never lands on
  // a company this machine joined before.
  const [origin, setOrigin] = useState<string | undefined>(props.initialOrigin);
  const view = useEnrolmentView(environmentId, origin);
  const [joiningAgain, setJoiningAgain] = useState(false);
  const step =
    origin === undefined || (joiningAgain && view?.state === "revoked")
      ? "address"
      : wizardStep(view);
  const notice =
    view !== null && canJoinAgain(view) ? joinAgainNotice(view) : lastResultMessage(view);
  const target =
    environmentId === null || origin === undefined ? null : { environmentId, relayOrigin: origin };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Join a company</DialogTitle>
        <DialogDescription>
          An Enterprise workspace joins this machine to your company's relay. Only facts about your
          work are shared, never your code or conversations. A machine can join several companies.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {step === "address" ? <WorkspaceKindChoice kind="enterprise" /> : null}
          {environmentId === null ? (
            <p className="text-muted-foreground text-sm">Connect to an environment first.</p>
          ) : step === "address" || target === null || view === null ? (
            <JoinForm
              key={origin ?? ""}
              environmentId={environmentId}
              initialOrigin={origin}
              notice={origin === undefined ? null : notice}
              onRelay={(next) => {
                setJoiningAgain(false);
                setOrigin(next);
              }}
            />
          ) : step === "code" || step === "awaiting" ? (
            <CodeStep target={target} view={view} />
          ) : step === "finishing" ? (
            <FinishingStep target={target} view={view} />
          ) : step === "revoked" ? (
            <RevokedStep
              view={view}
              onJoinAgain={() => setJoiningAgain(true)}
              onClose={props.onClose}
            />
          ) : (
            <ProjectStep target={target} view={view} onClose={props.onClose} />
          )}
        </div>
      </DialogPanel>
      {step === "address" ? (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
}
