import { useEffect, useState } from "react";
import {
  AuthEnvironmentMaintainScope,
  type PoolFounderAction,
  type PoolFounderView,
  type PoolCeilings,
} from "@t3tools/contracts";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEnvironmentScope } from "../state/session";
import { enrolmentRpc, relayKey, type RelayTarget } from "./enrolmentStore";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { PageHeader } from "./ui/PageHeader";
import { Section } from "./ui/Section";

type Host = PoolFounderView["hosts"][number];
type Submit = (action: PoolFounderAction) => void;
function fields({ limits, sizes }: PoolCeilings) {
  return {
    "Workspace seats": limits.workspaces.max,
    "CPUs per workspace": limits.workspaces.each.cpu,
    "Memory floor": limits.workspaces.each.memory_floor,
    "Memory maximum": limits.workspaces.each.memory_max,
    "Disk per workspace": limits.workspaces.each.disk,
    "Tasks per workspace": limits.workspaces.each.tasks,
    "Small slots": limits.sandbox_slots.small,
    "Large slots": limits.sandbox_slots.large,
    "Small CPUs": sizes.small.cpu,
    "Small memory": sizes.small.memory,
    "Small disk": sizes.small.disk,
    "Large CPUs": sizes.large.cpu,
    "Large memory": sizes.large.memory,
    "Large disk": sizes.large.disk,
  };
}

function Limits({ host, submit }: { host: Host; submit: Submit }) {
  const local = host.local && fields(host.local);
  const effective = host.effective && fields(host.effective);
  const requested = fields(host.requested);
  return (
    <Section title={host.requested.limits.id + " · " + host.requested.limits.level}>
      <form
        className="p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = (name: keyof typeof requested) => String(data.get(name));
          const number = (name: keyof typeof requested) => Number(value(name));
          submit({
            action: "limits",
            requested: {
              limits: {
                ...host.requested.limits,
                workspaces: {
                  max: number("Workspace seats"),
                  each: {
                    cpu: number("CPUs per workspace"),
                    memory_floor: value("Memory floor"),
                    memory_max: value("Memory maximum"),
                    disk: value("Disk per workspace"),
                    tasks: number("Tasks per workspace"),
                  },
                },
                sandbox_slots: { small: number("Small slots"), large: number("Large slots") },
              },
              sizes: {
                small: {
                  cpu: number("Small CPUs"),
                  memory: value("Small memory"),
                  disk: value("Small disk"),
                },
                large: {
                  cpu: number("Large CPUs"),
                  memory: value("Large memory"),
                  disk: value("Large disk"),
                },
              },
            },
          });
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {["Resource", "Host file", "Effective", "Relay request"].map((title) => (
                  <th className="p-1" key={title}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(Object.keys(requested) as (keyof typeof requested)[]).map((name) => {
                const numeric = typeof requested[name] === "number";
                return (
                  <tr key={name} className="border-t">
                    <th scope="row" className="p-1 font-normal">
                      {name}
                    </th>
                    <td>{local?.[name] ?? "Pending"}</td>
                    <td>{effective?.[name] ?? "Pending"}</td>
                    <td>
                      <Input
                        name={name}
                        aria-label={name}
                        type={numeric ? "number" : "text"}
                        min={0}
                        max={numeric && local ? Number(local[name]) : undefined}
                        pattern={numeric ? undefined : "[1-9][0-9]{0,8}[KMG]"}
                        required
                        disabled={!local}
                        defaultValue={requested[name]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button type="submit" disabled={!local}>
          Save limits
        </Button>
      </form>
    </Section>
  );
}

function SeatCommand({ personId }: { personId: string }) {
  const [command, setCommand] = useState("");
  return (
    <form
      className="space-y-2"
      onChange={() => setCommand("")}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (/^[A-Za-z0-9_-]{1,64}$/.test(personId))
          setCommand(
            "/opt/banneret-pool/banneret pool seat " +
              [
                personId,
                data.get("login"),
                Number(data.get("uid")),
                Number(data.get("port")),
                "--apply",
              ].join(" "),
          );
      }}
    >
      <p>Use the unused login, UID and port reserved by the host admin.</p>
      <div className="flex flex-wrap gap-2">
        <label>
          Login
          <Input name="login" pattern="[a-z][a-z0-9_]{0,24}" required />
        </label>
        <label>
          UID
          <Input name="uid" type="number" min={1000} max={59999} required />
        </label>
        <label>
          Seat port
          <Input name="port" type="number" min={20000} max={29999} required />
        </label>
        <Button type="submit">Show admin command</Button>
      </div>
      {command && <code className="block select-all break-all">{command}</code>}
    </form>
  );
}

function Controls({ target }: { target: RelayTarget }) {
  const [view, setView] = useState<PoolFounderView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const { environmentId, relayOrigin } = target;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected company's founder view on entry
  useEffect(() => {
    let active = true;
    void enrolmentRpc.poolFounder({ environmentId, relayOrigin }).then((result) => {
      if (!active) return;
      if (result.ok) setView(result.value);
      else setError(result.message);
      setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [environmentId, relayOrigin]);
  const submit = async (action?: PoolFounderAction) => {
    setBusy(true);
    setError("");
    const result = await enrolmentRpc.poolFounder(target, action);
    if (result.ok) setView(result.value);
    else setError(result.message);
    setBusy(false);
  };
  return (
    <fieldset disabled={busy} className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4">
      <PageHeader title="Offer a machine">
        <Button variant="outline" size="sm" onClick={() => void submit()}>
          Refresh
        </Button>
      </PageHeader>
      {error && <p role="alert">{error}</p>}
      {!view && busy && <p role="status">Loading host requests...</p>}
      {view && (
        <>
          <Section title="Pending host enrolments" count={view.enrolments.length}>
            {view.enrolments.length === 0 && <p className="p-3">No hosts awaiting confirmation.</p>}
            {view.enrolments.map(({ hostId, pairingId }) => (
              <form
                key={pairingId}
                className="flex flex-wrap items-end gap-2 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit({
                    action: "confirm",
                    pairingId,
                    code: String(new FormData(event.currentTarget).get("code")),
                  });
                }}
              >
                <div>
                  <strong>{hostId}</strong>
                  <p className="font-mono text-xs text-muted-foreground">{pairingId}</p>
                </div>
                <label>
                  Code from host admin
                  <Input name="code" pattern="[A-Z2-7]{8}" required />
                </label>
                <Button type="submit">Confirm host</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void submit({ action: "refuse", pairingId })}
                >
                  Refuse
                </Button>
              </form>
            ))}
          </Section>
          <Section title="Workspace requests" count={view.requests.length}>
            {view.requests.length === 0 && (
              <p className="p-3">No workspaces awaiting approval or setup.</p>
            )}
            {view.requests.map((w) => (
              <div key={w.requestId} className="space-y-2 border-b p-3">
                <p>
                  {w.personId} on {w.hostId}
                </p>
                {w.state === "asked" ? (
                  <Button
                    onClick={() => void submit({ action: "approve", requestId: w.requestId })}
                  >
                    Approve workspace
                  </Button>
                ) : (
                  <>
                    <strong>Approved for manual setup</strong>
                    <SeatCommand personId={w.personId} />
                  </>
                )}
              </div>
            ))}
          </Section>
          {view.hosts.map((host) => (
            <Limits key={JSON.stringify(host)} host={host} submit={submit} />
          ))}
        </>
      )}
    </fieldset>
  );
}
export function PoolFounderPage() {
  const company = useEnterpriseFeed();
  const permitted = useEnvironmentScope(
    company?.environmentId ?? null,
    AuthEnvironmentMaintainScope,
  );
  if (
    !company ||
    !permitted ||
    company.enrolment.me?.role !== "founder" ||
    !company.feed.sections.includes("pool")
  )
    return null;
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        {company.workspace.name} / Offer a machine
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Controls
          key={relayKey(company.target) + company.enrolment.me.login}
          target={company.target}
        />
      </div>
    </SidebarInset>
  );
}
