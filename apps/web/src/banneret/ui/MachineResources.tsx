import type { EnvironmentId, PoolResources, ResourceReport } from "@t3tools/contracts";
import { useEffectEvent, useEffect, useState } from "react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { useConnectedEnvironmentIds } from "../../state/environments";
import {
  enrolmentRpc,
  type RelayOutcome,
  type RelayTarget,
  useEnrolmentStore,
} from "../enrolmentStore";

function useReading<T>(key: string | null, read: () => Promise<RelayOutcome<T>>) {
  const [last, setLast] = useState<{ key: string; value: T | null } | null>(null);
  const readCurrent = useEffectEvent(read);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keep one current reading only while the machine is visible
  useEffect(() => {
    if (key === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const result = await readCurrent();
      if (!active || key === null) return;
      setLast({ key, value: result.ok ? result.value : null });
      timer = setTimeout(() => void refresh(), 15000);
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key]);
  return key !== null && last?.key === key ? last.value : null;
}
export function usePoolResources(target: RelayTarget | null, enabled: boolean) {
  const id = target?.environmentId,
    origin = target?.relayOrigin;
  const viewer = useEnrolmentStore((s) =>
    id
      ? s.views[id]?.find((v) => v.state === "configured" && v.relayOrigin === origin)?.me?.login
      : undefined,
  );
  const read = () => enrolmentRpc.pool({ environmentId: id!, relayOrigin: origin! });
  return useReading(
    id && origin && viewer && enabled ? JSON.stringify([id, origin, viewer]) : null,
    read,
  );
}
export const bytes = (v: number) =>
  v < 1024
    ? v + " B"
    : v < 2 ** 20
      ? (v / 1024).toFixed(1) + " KiB"
      : v >= 2 ** 30
        ? (v / 2 ** 30).toFixed(1) + " GiB"
        : (v / 2 ** 20).toFixed(1) + " MiB";
type Meter = NonNullable<ResourceReport["own"]["disk"]>;
export function ResourceBar({
  name,
  meter,
  format = String,
}: {
  name: string;
  meter: Meter | null;
  format?: (v: number) => string;
}) {
  return (
    <span className="flex min-w-28 flex-col gap-1 text-xs">
      <span className="flex justify-between gap-2">
        <span>
          {name}
          {meter?.warn ? " · Warning" : ""}
        </span>
        <span className={meter?.warn ? "text-destructive" : "text-muted-foreground"}>
          {meter
            ? format(meter.used) +
              (meter.limit === null ? " / unlimited" : " / " + format(meter.limit))
            : "Not measured"}
        </span>
      </span>
      {meter?.limit != null && meter.limit > 0 && (
        <span className="h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={meter.warn ? "block h-full bg-destructive" : "block h-full bg-primary"}
            style={{ width: Math.min(100, (100 * meter.used) / meter.limit) + "%" }}
          />
        </span>
      )}
    </span>
  );
}
type PoolHost = PoolResources["hosts"][number];
function ResourceSummary({
  report,
  host,
  workspace,
  mine,
  environmentId,
}: {
  report: ResourceReport | null;
  host: PoolHost | undefined;
  workspace?: PoolResources["me"]["workspaces"][number] | undefined;
  mine: boolean;
  environmentId: EnvironmentId | null;
}) {
  const [folders, setFolders] = useState<string | null>(null);
  const pressure = (host?.reporting ? host.contention : null) ?? (mine ? report?.host : null);
  const measured = pressure && (pressure.busy || Object.values(pressure.pressure).every(Boolean));
  const chip = measured
    ? pressure.busy
      ? "Host busy"
      : "Host available"
    : "Host pressure not measured";
  const own = mine ? report?.own : null;
  const quota = mine && host?.reporting ? workspace?.resources : null;
  const disk = quota?.disk ?? own?.disk ?? null,
    inodes = quota?.inodes ?? own?.inodes ?? null;
  const warn =
    disk?.warn ||
    inodes?.warn ||
    own?.memory?.warn ||
    own?.pids?.warn ||
    own?.cpu?.warn ||
    Object.values(own?.pressure ?? {}).some((p) => p?.warn);
  const hostText =
    pressure &&
    ["cpu", "io", "memory"]
      .map((key) => {
        const sample = pressure.pressure[key as keyof typeof pressure.pressure];
        return (
          key.toUpperCase() +
          " " +
          (sample
            ? (key === "memory" ? sample.full : sample.some).avg60.toFixed(1) + "%"
            : "not measured")
        );
      })
      .join(" · ");
  return (
    <span className="flex min-w-0 flex-col gap-1.5 py-1 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={
                pressure?.busy
                  ? "w-fit rounded-full border border-destructive px-2 py-0.5 text-xs text-destructive"
                  : "w-fit rounded-full border px-2 py-0.5 text-xs"
              }
            />
          }
        >
          {chip}
        </TooltipTrigger>
        <TooltipPopup>
          {hostText
            ? hostText + " · 60s pressure"
            : "No current pressure reading is available for this host."}
        </TooltipPopup>
      </Tooltip>
      {mine && measured && <span className="text-muted-foreground">{hostText} · 60s pressure</span>}
      {mine && pressure && (
        <span className="text-muted-foreground">
          {[
            pressure.memAvailableBytes === null
              ? null
              : bytes(pressure.memAvailableBytes) + " available on host",
            pressure.poolMemoryUsedBytes === null
              ? null
              : bytes(pressure.poolMemoryUsedBytes) +
                " pool RAM" +
                (pressure.poolMemoryLimitBytes === null
                  ? ""
                  : " / " + bytes(pressure.poolMemoryLimitBytes)),
            host?.reporting && host.contention
              ? host.contention.freeSlots.small +
                " small, " +
                host.contention.freeSlots.large +
                " large sandbox slots free"
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {mine && !own && !quota && (
        <span className="text-muted-foreground">Workspace resources not measured</span>
      )}
      {mine && (own || quota) && (
        <>
          <span className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            <ResourceBar
              name={quota?.disk ? "Storage quota" : "Home storage"}
              meter={disk}
              format={bytes}
            />
            <ResourceBar name="Memory" meter={own?.memory ?? null} format={bytes} />
            <ResourceBar
              name="CPU cores"
              meter={
                report?.cpuCores == null
                  ? null
                  : {
                      used: report.cpuCores,
                      limit: report.coreLimit,
                      warn: own?.cpu?.warn ?? false,
                    }
              }
              format={(v) => v.toFixed(2)}
            />
            <ResourceBar name="Processes" meter={own?.pids ?? null} />
            <ResourceBar name="Inodes" meter={inodes} />
          </span>
          <span className="text-muted-foreground">
            {own?.cpu
              ? "CPU throttled in " + own.cpu.throttledPercent.toFixed(1) + "% of periods (5 min)"
              : "CPU throttling not measured"}
          </span>
          {own && Object.values(own.pressure).some(Boolean) && (
            <span className="text-muted-foreground">
              Your pressure ·{" "}
              {Object.entries(own.pressure)
                .map(
                  ([key, p]) =>
                    key.toUpperCase() +
                    " " +
                    (p ? p.sample.some.avg60.toFixed(1) + "%" : "not measured"),
                )
                .join(" · ")}
            </span>
          )}
          {report?.recentOomKill && (
            <span className="text-destructive">
              A process in your workspace was killed after it ran out of memory.
            </span>
          )}
          {warn && (
            <span className="font-medium">
              Near a resource limit. Clean up your home, pick another machine or use a sandbox on
              another host.
            </span>
          )}
          {warn && environmentId && (
            <button
              className="w-fit underline"
              type="button"
              onClick={() => {
                setFolders("Reading folder sizes…");
                void enrolmentRpc
                  .folders(environmentId)
                  .then((r) =>
                    setFolders(
                      r.ok
                        ? r.value.map((f) => f.name + " (" + bytes(f.bytes) + ")").join(", ") ||
                            "No folders found."
                        : r.message,
                    ),
                  );
              }}
            >
              Show largest folders
            </button>
          )}
          {folders && <span role="status">{folders}</span>}
        </>
      )}
    </span>
  );
}
export function MachineResources({
  target,
  machineId,
  hostId,
  owner,
  selected,
  pool,
}: {
  target: RelayTarget;
  machineId?: string | undefined;
  hostId?: string | undefined;
  owner: string | undefined;
  selected?: EnvironmentId;
  pool: PoolResources | null;
}) {
  const views = useEnrolmentStore((state) => state.views);
  const connected = useConnectedEnvironmentIds();
  const primary = views[target.environmentId]?.find(
    (v) => v.relayOrigin === target.relayOrigin && v.state === "configured",
  );
  const mine = !!owner && primary?.me?.login.toLowerCase() === owner.toLowerCase();
  const environmentId =
    (mine &&
      connected.find(
        (id) =>
          (!selected || selected === id) &&
          views[id]?.some(
            (v) =>
              v.relayOrigin === target.relayOrigin &&
              v.state === "configured" &&
              v.me?.login.toLowerCase() === owner.toLowerCase() &&
              (selected !== undefined || v.machineId === machineId),
          ),
      )) ||
    null;
  const host = pool?.hosts.find((h) => h.hostId === hostId);
  const policy = host?.policy?.warnings;
  const read = () => enrolmentRpc.resources(environmentId!, policy);
  const key = environmentId ? JSON.stringify([environmentId, target.relayOrigin, owner]) : null;
  const report = useReading(key, read);
  return (
    <ResourceSummary
      key={key ?? "offline"}
      mine={mine}
      report={report}
      environmentId={environmentId}
      host={host}
      workspace={mine ? pool?.me.workspaces.find((w) => w.hostId === hostId) : undefined}
    />
  );
}
