import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useChatRead } from "./chat/client";

const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: "memory.preferences",
  label: "banneret:memory-preferences",
});
const write = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: "memory.configure",
  label: "banneret:configure-memory",
});

export function MemoryPreferences({ environmentId, threadId }: ScopedThreadRef) {
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
              nudges: data.has("nudges"),
            },
          });
          setSaving(false);
          if (result._tag === "Success") {
            setError("");
          } else setError("Could not save. Enter up to eight absolute folder paths.");
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
          <label>
            <input type="checkbox" name="nudges" defaultChecked={state.value.nudges} /> Find
            repeated corrections in this orchestrator
          </label>
          <button type="submit">Save preferences</button>
          {error && <p role="alert">{error}</p>}
        </fieldset>
      </form>
    </details>
  );
}
