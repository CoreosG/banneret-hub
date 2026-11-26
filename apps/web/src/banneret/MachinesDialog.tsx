// Banneret Hub: the company's machines as the relay lists them, with revoke, and Leave for this
// machine. Labels and logins come from the relay and render only as text.
import type { BanneretRelayMachine } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../components/ui/dialog";
import { usePrimaryEnvironmentId } from "../state/environments";
import { canForget } from "./enterprise.logic";
import { enrolmentRpc, storeEnrolmentView, useEnrolmentView } from "./enrolmentStore";
import {
  loadEnvironmentWorkspaces,
  setActiveWorkspace,
  useWorkspacesStore,
} from "./workspacesStore";

function machineStatus(machine: BanneretRelayMachine): string {
  if (machine.revokedAt !== undefined) return "Removed";
  return machine.connected ? "Connected" : "Not heard from";
}

export function MachinesPanel(props: { readonly onClose: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  const view = useEnrolmentView(environmentId);
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
    if (environmentId === null) return;
    let current = true;
    void enrolmentRpc.machines(environmentId).then((result) => {
      if (!current) return;
      if (result.ok) {
        setItems(result.value.items);
        setNextCursor(result.value.nextCursor);
      } else setError(result.message);
    });
    return () => {
      current = false;
    };
  }, [environmentId]);

  const loadMore = async () => {
    if (environmentId === null || nextCursor === null) return;
    const result = await enrolmentRpc.machines(environmentId, nextCursor);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setItems((previous) => [...(previous ?? []), ...result.value.items]);
    setNextCursor(result.value.nextCursor);
  };

  const revoke = async (machineId: string) => {
    if (environmentId === null) return;
    const result = await enrolmentRpc.revokeMachine(environmentId, machineId);
    setConfirming(null);
    if (!result.ok) setError(result.message);
    else showFirstPage(await enrolmentRpc.machines(environmentId));
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Machines</DialogTitle>
        <DialogDescription>
          Every machine joined to {view?.displayName ?? "the company"}. You can remove your own
          machines; founders can remove any.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {error !== null ? (
          <p role="alert" className="mb-3 text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {items === null ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <ul aria-label="Machines" className="flex flex-col rounded-md border">
            {items.map((machine) => (
              <li
                key={machine.id}
                className="flex items-center gap-2 px-2.5 py-2 not-last:border-b"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {machine.label}
                    {machine.thisMachine ? (
                      <span className="ml-1.5 text-muted-foreground text-xs">This machine</span>
                    ) : null}
                  </p>
                  <p className="truncate text-muted-foreground text-xs">
                    {machine.ownerLogin} · {machine.kind} · {machine.hostname} ·{" "}
                    {machineStatus(machine)}
                  </p>
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
      </DialogPanel>
      <DialogFooter>
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
        <Button type="button" variant="outline" onClick={props.onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

export function LeavePanel(props: { readonly onClose: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  const view = useEnrolmentView(environmentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const company = view?.displayName ?? "the company";

  const leave = async (mode: "revoke" | "forget") => {
    if (environmentId === null) return;
    setBusy(true);
    const result = await enrolmentRpc.leave(environmentId, mode);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    storeEnrolmentView(environmentId, result.value);
    if (useWorkspacesStore.getState().activeId === view?.workspaceId) setActiveWorkspace(null);
    void loadEnvironmentWorkspaces(environmentId);
    props.onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Leave {company}</DialogTitle>
        <DialogDescription>
          This machine leaves {company} and its workspace is removed. Your projects stay on this
          machine, in Personal.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {error !== null ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {canForget(view) ? (
          <p className="mt-2 text-muted-foreground text-sm">
            The relay cannot be reached. You can forget this machine here instead; a founder must
            then remove it on the relay.
          </p>
        ) : null}
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
