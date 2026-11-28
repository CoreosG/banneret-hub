import type { ThreadId, EnvironmentId, ToolLevel } from "@t3tools/contracts";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useChatRead } from "./chat/client";

const list = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Read thread tool levels",
  tag: "plugins.levels",
});
const save = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Change thread tool level",
  tag: "plugins.setLevel",
});
type Rows = readonly { source: string; level: ToolLevel }[];
export function LevelsPanel({
  load,
  change,
}: {
  load: () => Promise<Rows>;
  change: (source: string, level: ToolLevel) => Promise<Rows>;
}) {
  const state = useChatRead(load, 0);
  const [saved, setSaved] = useState<Rows>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <fieldset disabled={busy} className="grid gap-3 text-xs">
      {(saved ?? state.value)?.map(({ source, level }) => (
        <label key={source} className="flex justify-between gap-2">
          {source === "banneret" ? "Banneret tools" : source.slice("plugin:".length)}
          <select
            value={level}
            onChange={async (event) => {
              const next = event.currentTarget.value as ToolLevel;
              setBusy(true);
              setError("");
              try {
                setSaved(await change(source, next));
              } catch {
                setError("Could not save the tool level.");
              }
              setBusy(false);
            }}
          >
            <option value="none">None</option>
            <option value="read">Read</option>
            <option value="read_write">Read + write</option>
          </select>
        </label>
      ))}
      {!state.value && !state.error && <span>Loading tool levels...</span>}
      <p>Shell and files follow this thread's CLI permission mode.</p>
      {(state.error || error) && <span role="alert">{error || state.error}</span>}
    </fieldset>
  );
}
export function ThreadToolLevels({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  return (
    // Padded off the breadcrumb above: flush against it, the bare label read as a stuck tooltip.
    <div className="ps-(--workspace-gutter-start) pt-1">
      <Popover>
        <PopoverTrigger render={<Button variant="ghost-muted" size="xs" />}>
          Tool access
        </PopoverTrigger>
        <PopoverPopup align="start" width="md">
          <LevelsPanel
            load={async () => {
              const result = await runAtomCommand(appAtomRegistry, list, {
                environmentId,
                input: { threadId },
              });
              if (result._tag !== "Success") throw new Error("Could not read thread tool levels.");
              return result.value;
            }}
            change={async (source, level) => {
              const result = await runAtomCommand(appAtomRegistry, save, {
                environmentId,
                input: { threadId, source, level },
              });
              if (result._tag !== "Success") throw new Error("Could not save the tool level.");
              return result.value;
            }}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
