import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type PoolResources,
  type WorkspaceReceipt,
} from "@t3tools/contracts";
import { SidebarInset } from "../components/ui/sidebar";
import { useEnvironmentScope } from "../state/session";
import { Button } from "../components/ui/button";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { enrolmentRpc, type RelayTarget } from "./enrolmentStore";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { ResourceBar, bytes, usePoolResources } from "./ui/MachineResources";
import { PageHeader } from "./ui/PageHeader";

const labels = {
  asked: "Requested",
  approved: "Approved",
  ready_to_join: "Ready to join",
  active: "Active",
  suspended: "Suspended",
  removed: "Removed",
};

function HostCard({
  host,
  seat,
  target,
}: {
  host: PoolResources["hosts"][number];
  seat: PoolResources["me"]["workspaces"][number] | undefined;
  target: RelayTarget;
}) {
  const canRequest = useEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope);
  const [receipt, setReceipt] = useState<typeof WorkspaceReceipt.Type | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const state = seat?.state ?? receipt?.state;
  const limits = host.policy?.limits;
  const contention = host.reporting ? host.contention : null;
  const quota = host.reporting ? seat?.resources : null;
  return (
    <section className="space-y-2 rounded-lg border bg-card p-4">
      <h2 className="font-semibold">{host.hostId}</h2>
      <p>
        {limits
          ? `Capacity: ${limits.workspaces.max} workspaces, ${limits.sandbox_slots.small} small and ${limits.sandbox_slots.large} large sandbox slots`
          : "Capacity unavailable"}
      </p>
      <p>
        {contention
          ? `${contention.busy ? "Host busy" : "Host reporting"} · ${contention.freeSlots.small} small and ${contention.freeSlots.large} large sandbox slots free`
          : "No current host reading"}
      </p>
      {contention && (
        <p>
          {Object.entries(contention.pressure)
            .map(
              ([kind, sample]) =>
                kind.toUpperCase() +
                " " +
                (sample
                  ? (kind === "memory" ? sample.full : sample.some).avg60 + "%"
                  : "unmeasured"),
            )
            .join(" · ")}{" "}
          (60s pressure)
        </p>
      )}
      {state && <p role="status">Your workspace: {labels[state]}</p>}
      {quota && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ResourceBar name="Storage quota" meter={quota.disk} format={bytes} />
          <ResourceBar name="Inodes" meter={quota.inodes} />
        </div>
      )}
      {(state === "ready_to_join" || state === "active") && (
        <p>
          Use the SSH login and seat port from your administrator. Forward that port to the same
          port on your desktop. From your seat login run <code>banneret pair</code>, then open its
          one-time link in Banneret Hub on your desktop. In your company's Machines dialog choose
          Join for that seat and confirm your sign-in code. Select the seat environment to open a
          project. To link agents, enable Linked environments in desktop Labs. In Settings →
          Environments link from your desktop using the forwarded address and a fresh pairing code.
        </p>
      )}
      {host.level === "staff" && !state && (
        <Button
          disabled={!canRequest || pending || !host.reporting}
          onClick={async () => {
            setPending(true);
            const result = await enrolmentRpc.requestWorkspace(target, host.hostId);
            if (result.ok) {
              setReceipt(result.value);
              setError("");
            } else setError(result.message);
            setPending(false);
          }}
        >
          Request a workspace on a shared machine
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function PoolPage() {
  const enterprise = useEnterpriseFeed();
  const enabled = enterprise?.feed.sections.includes("pool") ?? false;
  const pool = usePoolResources(enterprise?.target ?? null, enabled);
  if (!enterprise || !enabled) return null;
  return (
    <SidebarInset role="main" className="scrollbar-gutter-both h-dvh overflow-y-auto">
      <WorkspacePageHeader electron={isElectron}>
        {enterprise.workspace.name} / Pool
      </WorkspacePageHeader>
      <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
        <PageHeader title="Pool" />
        {!pool ? (
          <p role="status">Waiting for pool resources.</p>
        ) : pool.hosts.length === 0 ? (
          <p>No shared hosts.</p>
        ) : (
          pool.hosts.map((host) => (
            <HostCard
              key={JSON.stringify([
                enterprise.environmentId,
                enterprise.target.relayOrigin,
                enterprise.enrolment.me?.login,
                host.hostId,
              ])}
              host={host}
              target={enterprise.target}
              seat={pool.me.workspaces.find((w) => w.hostId === host.hostId)}
            />
          ))
        )}
      </div>
    </SidebarInset>
  );
}
