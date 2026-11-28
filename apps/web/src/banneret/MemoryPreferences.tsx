import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useChatRead } from "./chat/client";
import { OwnedElsewhere } from "./OwnedElsewhere";

const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: "memory.preferences",
  label: "banneret:memory-preferences",
});
const write = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: "memory.configure",
  label: "banneret:configure-memory",
});

export function MemoryPreferences({ environmentId, threadId }: ScopedThreadRef) {
  const generators = useEnvironmentSettings(environmentId).textGenerators;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const state = useChatRead(async () => {
    const result = await runAtomCommand(appAtomRegistry, read, {
      environmentId,
      input: { threadId },
    });
    if (result._tag !== "Success") throw new Error("Could not read memory preferences.");
    return result.value;
  }, [environmentId, threadId].join(":"));
  if (!state.value) return state.error ? <p role="alert">{state.error}</p> : null;
  return (
    <details className="px-3 py-2 text-sm">
      <summary>Memory preferences</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setSaving(true);
          const result = await runAtomCommand(appAtomRegistry, write, {
            environmentId,
            input: {
              threadId,
              folders: String(data.get("folders") ?? "")
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean),
              watcher: {
                enabled: data.has("watcher"),
                generator: String(data.get("generator") ?? ""),
                model: String(data.get("model") ?? "").trim(),
                muted: String(data.get("muted") ?? "")
                  .split(/\s+/)
                  .filter(Boolean),
              },
              nudges: data.has("nudges"),
            },
          });
          setSaving(false);
          if (result._tag === "Success") {
            setError("");
          } else setError("Could not save. Check folder paths and reminder settings.");
        }}
      >
        <fieldset disabled={saving} className="grid gap-2">
          <label>
            Workspace knowledge folders on this machine, one absolute path per line
            <textarea
              className="block w-full border"
              name="folders"
              defaultValue={state.value.folders.join("\n")}
            />
          </label>
          <OwnedElsewhere capabilities={["search"]} />
          <label>
            <input type="checkbox" name="nudges" defaultChecked={state.value.nudges} /> Find
            repeated corrections in this orchestrator
          </label>
          <label>
            <input type="checkbox" name="watcher" defaultChecked={state.value.watcher?.enabled} />{" "}
            Rule reminders for this orchestrator
          </label>
          <p>
            The selected generator compares matching activity, Banneret notes and excerpts from
            provider memory. You choose how to resolve possible contradictions.
          </p>
          <label>
            Text generator{" "}
            <select name="generator" defaultValue={state.value.watcher?.generator}>
              <option value="">Choose a configured text generator</option>
              {Object.entries(generators)
                .filter(([, g]) => g.enabled)
                .map(([id, g]) => (
                  <option key={id} value={id}>
                    {g.label || g.baseUrl}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Reminder model{" "}
            <input
              name="model"
              maxLength={128}
              defaultValue={state.value.watcher?.model}
              placeholder="Model ID from the generator"
            />
          </label>
          <label>
            Muted rule keys, one per line{" "}
            <textarea name="muted" defaultValue={state.value.watcher?.muted.join("\n")} />
          </label>
          <button type="submit">Save preferences</button>
          {error && <p role="alert">{error}</p>}
        </fieldset>
      </form>
    </details>
  );
}
