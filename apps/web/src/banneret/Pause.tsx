import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PauseAction, PauseStatus } from "@t3tools/contracts";
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Button } from "../components/ui/button";
import { SettingsRow } from "../components/settings/settingsLayout";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../state/environments";

const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:pause:status",
  tag: "banneretPause.status",
});
const change = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:pause:change",
  tag: "banneretPause.change",
});
type Entry = { status?: PauseStatus; busy?: boolean; error?: string };
export const usePause = create<Record<string, Entry>>(() => ({}));
function update(id: EnvironmentId, patch: Entry) {
  usePause.setState((state) => ({ [id]: { ...state[id], ...patch } }));
}
export async function changePause(id: EnvironmentId, input: PauseAction) {
  if (usePause.getState()[id]?.busy) return;
  update(id, { busy: true, error: "" });
  try {
    const result = await runAtomCommand(appAtomRegistry, change, { environmentId: id, input });
    if (result._tag !== "Success") throw new Error();
    update(id, { status: result.value });
  } catch {
    update(id, { error: "Could not change pause on this machine." });
  } finally {
    update(id, { busy: false });
  }
}
export function PauseBanner({
  status,
  label,
  disabled,
  onAction,
}: {
  status: PauseStatus;
  label: string;
  disabled: boolean;
  onAction: (action: PauseAction) => void;
}) {
  return (
    <section
      aria-label="Paused agents"
      className="pointer-events-auto max-h-[50vh] overflow-auto rounded-lg border border-warning/50 bg-background p-4 text-sm shadow-lg"
    >
      <div className="flex items-center gap-3">
        <PauseIcon className="size-5 text-warning" />
        <div className="grow">
          <strong>Your agents are paused</strong>
          <p>Automatic work on {label} waits until you resume.</p>
        </div>
        <Button disabled={disabled} onClick={() => onAction({ kind: "resume" })}>
          <PlayIcon />
          Resume
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-3 border-t pt-2">
        <strong className="grow">Still running ({status.running.length})</strong>
        <Button
          variant="outline"
          disabled={disabled || !status.running.length}
          onClick={() => onAction({ kind: "stopAll" })}
        >
          Stop all
        </Button>
      </div>
      {status.running.map((run) => (
        <div key={run.runId} className="flex items-center gap-2 py-1">
          <span className="grow">{run.title}</span>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => onAction({ kind: "stop", threadId: run.threadId, runId: run.runId })}
          >
            <SquareIcon />
            Stop
          </Button>
        </div>
      ))}
      <div className="mt-2 border-t pt-2">Held while paused · {status.held} held</div>
    </section>
  );
}
function MachineBanner({ id, label }: { id: EnvironmentId; label: string }) {
  const entry = usePause((s) => s[id]);
  const allowed = useAtomValue(read.permissionAtom(id));
  const writable = useAtomValue(change.permissionAtom(id));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observe changes from the MCP tool and other clients
  useEffect(() => {
    if (!allowed) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const before = usePause.getState()[id];
      const result = await runAtomCommand(appAtomRegistry, read, {
        environmentId: id,
        input: {},
      }).catch(() => null);
      if (
        current &&
        !before?.busy &&
        before === usePause.getState()[id] &&
        result?._tag === "Success"
      )
        update(id, { status: result.value });
      if (current) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, allowed]);
  return (
    <>
      {entry?.status?.paused && allowed && (
        <PauseBanner
          status={entry.status}
          label={label}
          disabled={!writable || !!entry.busy}
          onAction={(action) => void changePause(id, action)}
        />
      )}
      {entry?.error && (
        <p role="alert" className="rounded bg-background p-2">
          {entry.error}
        </p>
      )}
    </>
  );
}
export function PauseHost() {
  const ids = useConnectedEnvironmentIds();
  const machines = useEnvironmentIdentities();
  return (
    <div className="pointer-events-none fixed inset-x-4 top-10 z-40 mx-auto grid max-w-2xl gap-2">
      {ids.map((id) => (
        <MachineBanner
          key={id}
          id={id}
          label={machines.find((m) => m.environmentId === id)?.label ?? id}
        />
      ))}
    </div>
  );
}
/** "Pause new work" and "Stop all" for one machine, for places outside the paused banner. */
export function PauseControls({
  id,
  size = "default",
}: {
  id: EnvironmentId;
  size?: "xs" | "default";
}) {
  const entry = usePause((s) => s[id]);
  const writable = useAtomValue(change.permissionAtom(id));
  // Stop all interrupts every running turn, so one click away from a chat asks first.
  const [confirming, setConfirming] = useState(false);
  const disabled = !writable || !!entry?.busy || !entry?.status;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size={size}
        disabled={disabled}
        onClick={() => void changePause(id, { kind: entry?.status?.paused ? "resume" : "pause" })}
      >
        {entry?.status?.paused ? "Resume" : "Pause new work"}
      </Button>
      {confirming ? (
        <div
          role="group"
          aria-label="Confirm stop all"
          className="flex flex-wrap items-center gap-2"
        >
          <span>Pause new work and interrupt every running turn on this machine?</span>
          <Button
            variant="destructive"
            size={size}
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              void changePause(id, { kind: "stopAll" });
            }}
          >
            Stop everything
          </Button>
          <Button variant="ghost" size={size} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size={size}
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          Stop all
        </Button>
      )}
    </div>
  );
}
export function PauseSetting({ id, label }: { id: EnvironmentId; label: string }) {
  return (
    <SettingsRow
      title={label}
      description="Pause new work lets running turns finish. Stop all also interrupts them."
      control={<PauseControls id={id} />}
    />
  );
}
