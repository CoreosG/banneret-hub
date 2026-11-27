import { useEffect, useState } from "react";
import type { PoolResources, SandboxReceipt, SandboxAction } from "@t3tools/contracts";
import { Select, SelectTrigger, SelectItem, SelectPopup } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { enrolmentRpc, type RelayTarget } from "./enrolmentStore";

function Booking({ id, target, enabled }: { id: string; target: RelayTarget; enabled: boolean }) {
  const [data, setData] = useState<typeof SandboxReceipt.Type | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { environmentId, relayOrigin } = target;
  const ended = data?.state === "ended";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follow the owner's relay booking while this card is visible
  useEffect(() => {
    if (ended || pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const result = await enrolmentRpc.sandbox(
        { environmentId, relayOrigin },
        { kind: "read", id },
      );
      if (!live) return;
      if (result.ok) {
        setData(result.value);
        setError("");
      } else setError(result.message);
      timer = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ended, pending, environmentId, relayOrigin, id]);
  const change = async (kind: "extend" | "cancel") => {
    setPending(true);
    const r = await enrolmentRpc.sandbox(target, { kind, id });
    if (r.ok) {
      setData(r.value);
      setError("");
    } else setError(r.message);
    setPending(false);
  };
  return (
    <div className="space-y-2 border-t pt-3">
      <p role="status">
        Sandbox {id}: {data?.state.replace("_", " ") ?? "Loading"}
      </p>
      {data?.place != null && (
        <p>
          Place in line: {data.place}
          {data.waitSeconds != null && ` · Estimated wait: ${Math.ceil(data.waitSeconds / 60)} min`}
        </p>
      )}
      {data?.endsAt && <p>End time: {new Date(data.endsAt).toLocaleString()}</p>}
      {data?.reason && <p>{data.reason.replaceAll("_", " ")}</p>}
      {data?.state === "starting" && (
        <p>
          In your SSH login, find your container with{" "}
          <code>podman ps --filter label=banneret.sandbox={id}</code>. Forward desktop port 3793 to
          the loopback port listed for that container. Run{" "}
          <code>podman exec CONTAINER banneret pair</code>, open its link on your desktop and join
          that environment in your company's Machines dialog.
        </p>
      )}
      {data?.state === "running" && (
        <p>
          Select the paired sandbox environment for machine {data.machineId}. Open a project there
          and start a thread. Sign in to your providers in the sandbox.
        </p>
      )}
      {data && ["offered", "waiting", "starting", "running"].includes(data.state) && (
        <Button disabled={!enabled || pending} onClick={() => void change("cancel")}>
          Cancel sandbox
        </Button>
      )}
      {data?.state === "running" && (
        <Button disabled={!enabled || pending} onClick={() => void change("extend")}>
          Extend sandbox
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function SandboxControls({
  pool,
  hostId,
  target,
  enabled,
  taskId,
}: {
  pool: PoolResources;
  hostId: string;
  target: RelayTarget;
  enabled: boolean;
  taskId?: string | undefined;
}) {
  const policy = pool.sandboxes;
  const [size, setSize] = useState<"small" | "large">("small");
  const [image, setImage] = useState("");
  const [created, setCreated] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const digest = image || policy?.images[0]?.digest;
  const ids = new Set([
    ...pool.bookings.filter((b) => b.hostId === hostId).map((b) => b.id),
    ...created,
  ]);
  async function launch() {
    if (!digest) return;
    setPending(true);
    const action: typeof SandboxAction.Type = {
      kind: "launch",
      hostId,
      size,
      image: digest,
      ...(taskId && { taskId }),
    };
    const r = await enrolmentRpc.sandbox(target, action);
    if (r.ok) {
      setCreated((previous) => [...previous, r.value.id]);
      setError("");
    } else setError(r.message);
    setPending(false);
  }
  return (
    <div className="space-y-3">
      {policy && (
        <div className="space-y-2 border-t pt-3">
          <p>
            Time limit: {policy.time_limit} · Idle limit: {policy.idle_limit} · Extension:{" "}
            {policy.extend}
          </p>
          <p>
            Unkept work is deleted at expiry. Push your commits or copy files out before it ends.
          </p>
          {taskId && <p>For task {taskId}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Select value={size} onValueChange={(v) => v && setSize(v)}>
              <SelectTrigger size="sm" aria-label="Sandbox size">
                Size: {size}
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="large">Large</SelectItem>
              </SelectPopup>
            </Select>
            <Select value={digest ?? null} onValueChange={(v) => v && setImage(v)}>
              <SelectTrigger size="sm" aria-label="Sandbox image">
                Image: {policy.images.find((i) => i.digest === digest)?.name ?? "Unavailable"}
              </SelectTrigger>
              <SelectPopup>
                {policy.images.map((i) => (
                  <SelectItem key={i.digest} value={i.digest}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button disabled={!enabled || !digest || pending} onClick={() => void launch()}>
              Launch a sandbox
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {[...ids].map((id) => (
        <Booking key={id} {...{ id, target, enabled }} />
      ))}
    </div>
  );
}
