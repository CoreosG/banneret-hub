import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

const list = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "List Solo plugins",
  tag: "plugins.list",
});
const add = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Add Solo plugin",
  tag: "plugins.add",
});
const remove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Remove Solo plugin",
  tag: "plugins.remove",
});

function Plugins({
  workspaceId,
  environmentId,
}: {
  workspaceId: string;
  environmentId: EnvironmentId;
}) {
  const writable = useAtomValue(add.permissionAtom(environmentId));
  const [plugins, setPlugins] = useState<
    ReadonlyArray<{
      source: string;
      description: string;
      auth: string;
      capabilities: readonly string[];
    }>
  >([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const endpoint = useRef<HTMLInputElement>(null);
  const manifest = useRef<HTMLInputElement>(null);
  const token = useRef<HTMLInputElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load this workspace's registrations from the selected environment
  useEffect(() => {
    let active = true;
    void runAtomCommand(appAtomRegistry, list, { environmentId, input: { workspaceId } }).then(
      (result) => {
        if (!active) return;
        if (result._tag === "Success") setPlugins(result.value);
        else setError("Could not load plugins.");
        setBusy(false);
      },
    );
    return () => {
      active = false;
    };
  }, [environmentId, workspaceId]);
  async function save(source?: string) {
    setBusy(true);
    setError("");
    try {
      const result = source
        ? await runAtomCommand(appAtomRegistry, remove, {
            environmentId,
            input: { workspaceId, source },
          })
        : await runAtomCommand(appAtomRegistry, add, {
            environmentId,
            input: {
              workspaceId,
              endpoint: endpoint.current?.value ?? "",
              manifestUrl: manifest.current?.value,
              token: Redacted.make(token.current?.value ?? ""),
            },
          });
      if (result._tag === "Success") setPlugins(result.value);
      else {
        const error = Cause.squash(result.cause);
        setError(
          typeof error === "object" &&
            error !== null &&
            "detail" in error &&
            typeof error.detail === "string"
            ? error.detail
            : "Could not update plugins.",
        );
      }
    } catch {
      setError("Could not reach this machine.");
    }
    if (token.current) token.current.value = "";
    setBusy(false);
  }
  return (
    <fieldset
      disabled={!writable || busy}
      className="grid gap-2"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <legend>Solo plugins</legend>
      {plugins.map((p) => (
        <div key={p.source}>
          <strong>{p.source}</strong> {p.description}
          <p>
            {p.capabilities.join(", ")} · {p.auth}
          </p>
          <Button type="button" variant="outline" onClick={() => void save(p.source)}>
            Remove {p.source}
          </Button>
        </div>
      ))}
      <label>
        MCP endpoint
        <Input ref={endpoint} placeholder="http://127.0.0.1:8787/mcp" />
      </label>
      <label>
        Manifest URL (optional)
        <Input ref={manifest} placeholder="Defaults to plugin.json beside the endpoint" />
      </label>
      <label>
        Access token
        <Input ref={token} type="password" autoComplete="new-password" />
      </label>
      {error && <p role="alert">{error}</p>}
      <Button type="button" onClick={() => void save()}>
        Add a plugin by URL
      </Button>
    </fieldset>
  );
}

export function SoloPlugins({ workspaceId }: { workspaceId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? (
    <Plugins
      key={environmentId + workspaceId}
      environmentId={environmentId}
      workspaceId={workspaceId}
    />
  ) : null;
}
