import { useServerConfigs } from "../state/entities";
import { MachineResources, usePoolResources } from "./ui/MachineResources";
import { useEnvironmentFeed } from "./relayFeedStore";
import type { BanneretRelayMachine, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../components/ui/dialog";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { CopyDetails } from "./EnterpriseWizard";
import {
  canForget,
  cleanLogin,
  forgetNotice,
  machineEnrolment,
  peerUpdateMessage,
} from "./enterprise.logic";
import {
  enrolmentRpc,
  storeEnrolmentView,
  useEnrolmentStore,
  useJoinedElsewhere,
  useEnrolmentView,
} from "./enrolmentStore";
import {
  openWorkspaceDialog,
  loadEnvironmentWorkspaces,
  setActiveWorkspace,
  useWorkspacesStore,
} from "./workspacesStore";

function machineStatus(machine: BanneretRelayMachine): string {
  if (machine.revokedAt !== undefined) return "Removed";
  return machine.connected ? "Connected" : "Not heard from";
}

export function MachinesPanel(props: { readonly origin: string; readonly onClose: () => void }) {
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const missing = useEnrolmentStore((state) => state.missingStatusRpc);
  const identities = useEnvironmentIdentities();
  const views = useEnrolmentStore((state) => state.views);
  const machines = useEnrolmentStore((state) => state.machines);
  const rows = connected.map((environmentId) => ({
    environmentId,
    label:
      identities.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId,
    view: views[environmentId]?.find((entry) => entry.relayOrigin === props.origin),
    known: machines[environmentId] !== undefined,
  }));
  const joined = rows.filter((row) => row.view?.state === "configured");
  const roster = joined.find((row) => row.environmentId === primary) ?? joined[0];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Machines</DialogTitle>
        <DialogDescription>
          Manage your connected machines for {roster?.view?.displayName ?? props.origin}.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <h3 className="mb-2 font-medium text-sm">Your machines</h3>
        <ul aria-label="Your machines" className="flex flex-col rounded-md border">
          {rows.map(({ environmentId, label, view, known }) => {
            const state = view?.state ?? (known ? "none" : "unknown");
            const update = peerUpdateMessage(
              configs.get(environmentId)?.environment.serverVersion,
              !!missing[environmentId],
            );
            const status = update ?? machineEnrolment[state];
            const pending = status === "Pending";
            return (
              <li
                key={environmentId}
                aria-label={label}
                className="flex items-center gap-2 px-2.5 py-2 not-last:border-b"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{label}</p>
                  <p className="text-muted-foreground text-xs">
                    {status}
                    {update && <span className="block">Update Banneret Hub on {label}.</span>}
                    {pending && view?.confirmCode ? ` · code ${view.confirmCode}` : ""}
                  </p>
                </div>
                {pending && view && (
                  <CopyDetails target={{ environmentId, relayOrigin: props.origin }} view={view} />
                )}
                {!update && state !== "unknown" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      openWorkspaceDialog({
                        kind: state === "configured" ? "leave" : "enterprise",
                        origin: props.origin,
                        environmentId,
                      })
                    }
                  >
                    {state === "configured"
                      ? `Leave ${label}…`
                      : pending
                        ? "View join…"
                        : `Join ${label}…`}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {roster && (
          <CompanyMachines
            key={roster.environmentId}
            origin={props.origin}
            environmentId={roster.environmentId}
            primary={primary}
          />
        )}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function CompanyMachines(props: {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  readonly primary: EnvironmentId | null;
}) {
  const { environmentId } = props;
  const target = { environmentId, relayOrigin: props.origin };
  const feed = useEnvironmentFeed(target);
  const me = useEnrolmentView(environmentId, props.origin)?.me;
  const outside = me?.admission === "outside";
  const pool = usePoolResources(
    target,
    feed.sections.includes("pool") && (!outside || me.permissions.includes("hub.pool")),
  );
  const [items, setItems] = useState<ReadonlyArray<BanneretRelayMachine> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const showFirstPage = (result: Awaited<ReturnType<typeof enrolmentRpc.machines>>) => {
    if (result.ok) {
      setItems(result.value.items);
      setNextCursor(result.value.nextCursor);
      setError(null);
    } else setError(result.message);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the relay's machine list through the server when the panel opens
  useEffect(() => {
    let current = true;
    void enrolmentRpc.machines({ environmentId, relayOrigin: props.origin }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setItems(result.value.items);
        setNextCursor(result.value.nextCursor);
      } else setError(result.message);
    });
    return () => {
      current = false;
    };
  }, [environmentId, props.origin]);

  const loadMore = async () => {
    if (nextCursor === null) return;
    const result = await enrolmentRpc.machines(target, nextCursor);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setItems((previous) => [...(previous ?? []), ...result.value.items]);
    setNextCursor(result.value.nextCursor);
  };

  const revoke = async (machineId: string) => {
    const result = await enrolmentRpc.revokeMachine(target, machineId);
    setConfirming(null);
    if (!result.ok) setError(result.message);
    else showFirstPage(await enrolmentRpc.machines(target));
  };

  return (
    <>
      <h3 className="mt-4 mb-2 font-medium text-sm">Company machines</h3>
      {error !== null ? (
        <p role="alert" className="mb-3 text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {items === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <ul aria-label="Machines" className="flex flex-col rounded-md border">
          {items
            .filter(
              (machine) =>
                !outside ||
                me.permissions.includes("hub.machinesAll") ||
                machine.ownerLogin === me.login,
            )
            .map((machine) => (
              <li
                key={machine.id}
                className="flex items-center gap-2 px-2.5 py-2 not-last:border-b"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {machine.label}
                    {machine.thisMachine && environmentId === props.primary ? (
                      <span className="ml-1.5 text-muted-foreground text-xs">This machine</span>
                    ) : null}
                  </p>
                  <p className="truncate text-muted-foreground text-xs">
                    {[
                      cleanLogin(machine.ownerLogin),
                      machine.kind,
                      machine.hostname,
                      machineStatus(machine),
                    ]
                      .filter((part) => part !== "")
                      .join(" \u00b7 ")}
                  </p>
                  {machine.revokedAt === undefined && (
                    <MachineResources
                      target={target}
                      machineId={machine.id}
                      hostId={machine.poolHostId}
                      owner={machine.ownerLogin}
                      pool={pool}
                    />
                  )}
                </div>
                {machine.revocable && !machine.thisMachine ? (
                  <Button
                    size="xs"
                    type="button"
                    variant={confirming === machine.id ? "destructive" : "destructive-outline"}
                    onClick={() =>
                      confirming === machine.id
                        ? void revoke(machine.id)
                        : setConfirming(machine.id)
                    }
                  >
                    {confirming === machine.id ? "Remove for good" : "Remove"}
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
      )}
      {nextCursor !== null ? (
        <Button
          className="sm:mr-auto"
          type="button"
          variant="ghost"
          onClick={() => void loadMore()}
        >
          Show more
        </Button>
      ) : null}
    </>
  );
}

export function LeavePanel(props: {
  readonly switchAccount: boolean;
  readonly selectedId: EnvironmentId | undefined;
  readonly origin: string;
  readonly onClose: () => void;
}) {
  const primary = usePrimaryEnvironmentId();
  const environmentId = props.selectedId ?? primary;
  const identities = useEnvironmentIdentities();
  const label =
    identities.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId;
  const keepWorkspace = useJoinedElsewhere(environmentId, props.origin);
  const view = useEnrolmentView(environmentId, props.origin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const company = view?.displayName ?? "the company";
  const notice = forgetNotice(view);

  const leave = async (mode: "revoke" | "forget") => {
    if (environmentId === null) return;
    setBusy(true);
    const result = await enrolmentRpc.leave(
      { environmentId, relayOrigin: props.origin },
      mode,
      keepWorkspace,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    storeEnrolmentView(environmentId, result.value);
    if (!keepWorkspace && useWorkspacesStore.getState().activeId === view?.workspaceId)
      setActiveWorkspace(null);
    void loadEnvironmentWorkspaces(environmentId);
    if (props.switchAccount)
      openWorkspaceDialog({ kind: "enterprise", environmentId, origin: props.origin });
    else props.onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Leave {company}</DialogTitle>
        <DialogDescription>
          Leaving revokes access to {company} on {label}.{" "}
          {keepWorkspace
            ? "Your other machines keep the workspace."
            : "Its projects return to Personal."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {error !== null ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {notice !== null ? <p className="mt-2 text-muted-foreground text-sm">{notice}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        {canForget(view) ? (
          <Button
            type="button"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void leave("forget")}
          >
            Forget this machine here
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => void leave("revoke")}
        >
          Leave
        </Button>
      </DialogFooter>
    </>
  );
}
