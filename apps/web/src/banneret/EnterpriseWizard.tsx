// Banneret Hub: join this machine to a company relay. Address, then "Join <company>", then the code
// the person types on the relay's sign-in page, then the projects that belong to the company. The
// server holds the key and token; this screen only shows what `banneretRelay.status` says.
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
  refreshEnrolment,
  storeEnrolmentView,
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

function JoinForm(props: {
  readonly environmentId: EnvironmentId;
  readonly initialOrigin: string | undefined;
  readonly notice: string | null;
  readonly onStarted: (origin: string) => void;
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

  const check = async () => {
    setBusy(true);
    setError(null);
    const result = await enrolmentRpc.probe(props.environmentId, address);
    setBusy(false);
    if (result.ok) setRelay(result.value);
    else setError(result.message);
  };
  const join = async () => {
    if (relay === null) return;
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
    props.onStarted(relay.origin);
    storeEnrolmentView(props.environmentId, result.value);
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
      {props.notice !== null ? (
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

function CodeStep(props: {
  readonly environmentId: EnvironmentId;
  readonly view: BanneretEnrolmentView;
}) {
  const now = useNow(1000);
  const awaiting = props.view.state === "awaiting_approval";
  const cancel = async () => {
    const result = await enrolmentRpc.cancel(props.environmentId);
    if (result.ok) storeEnrolmentView(props.environmentId, result.value);
    else void refreshEnrolment(props.environmentId);
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
  readonly environmentId: EnvironmentId;
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
    if (result.ok) storeEnrolmentView(props.environmentId, result.value);
    else {
      setError(result.message);
      void refreshEnrolment(props.environmentId);
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
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => enrolmentRpc.cancel(props.environmentId))}
        >
          Cancel
        </Button>
        {canForget(props.view) ? (
          <Button
            type="button"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void act(() => enrolmentRpc.leave(props.environmentId, "forget"))}
          >
            Forget this machine here
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProjectStep(props: {
  readonly environmentId: EnvironmentId;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the workspace the server just wrote and the company's repository list once joined
  useEffect(() => {
    void loadEnvironmentWorkspaces(props.environmentId);
    let current = true;
    void enrolmentRpc
      .matchProjects(props.environmentId, remoteKey === "" ? [] : remoteKey.split("\n"))
      .then((result) => {
        if (current) setMatched(new Set(result.ok ? result.value.matched : []));
      });
    return () => {
      current = false;
    };
  }, [props.environmentId, remoteKey]);

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
  readonly initialOrigin: string | undefined;
  readonly onClose: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const view = useEnrolmentView(environmentId);
  const [joiningAgain, setJoiningAgain] = useState(false);
  const [lastOrigin, setLastOrigin] = useState<string | undefined>(undefined);
  const step = joiningAgain && view?.state === "revoked" ? "address" : wizardStep(view);
  const initialOrigin =
    props.initialOrigin ?? (step === "address" ? (view?.relayOrigin ?? lastOrigin) : undefined);
  const notice =
    view !== null && canJoinAgain(view) ? joinAgainNotice(view) : lastResultMessage(view);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Join a company</DialogTitle>
        <DialogDescription>
          An Enterprise workspace joins this machine to your company's relay. Only facts about your
          work are shared, never your code or conversations.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {step === "address" ? <WorkspaceKindChoice kind="enterprise" /> : null}
          {environmentId === null ? (
            <p className="text-muted-foreground text-sm">Connect to an environment first.</p>
          ) : step === "address" ? (
            <JoinForm
              key={initialOrigin ?? ""}
              environmentId={environmentId}
              initialOrigin={initialOrigin}
              notice={notice}
              onStarted={setLastOrigin}
            />
          ) : step === "code" || step === "awaiting" ? (
            <CodeStep environmentId={environmentId} view={view!} />
          ) : step === "finishing" ? (
            <FinishingStep environmentId={environmentId} view={view!} />
          ) : step === "revoked" ? (
            <RevokedStep
              view={view!}
              onJoinAgain={() => setJoiningAgain(true)}
              onClose={props.onClose}
            />
          ) : (
            <ProjectStep environmentId={environmentId} view={view!} onClose={props.onClose} />
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
