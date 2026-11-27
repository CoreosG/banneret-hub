import { useChatRead } from "./chat/client";
import { useState } from "react";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-repo",
  tag: "memory.repoSetting",
});
const save = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:configure-memory-repo",
  tag: "memory.setRepo",
});
const sync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:sync-memory",
  tag: "memory.sync",
});

export function MemoryRepo({
  environmentId,
  threadId,
  refresh,
  revision,
}: ScopedThreadRef & { refresh?: (() => void) | undefined; revision?: number | undefined }) {
  const setting = useChatRead(async () => {
    const result = await runAtomCommand(appAtomRegistry, read, {
      environmentId,
      input: { threadId },
    });
    if (result._tag !== "Success") throw new Error("Could not read Git copy settings.");
    return result.value;
  }, [environmentId, threadId, revision].join(":"));
  const [draftUrl, setUrl] = useState<string>();
  const [draftProjects, setProjects] = useState<boolean>();
  const url = draftUrl ?? setting.value?.url ?? "";
  const projects = draftProjects ?? setting.value?.projects ?? false;
  const [message, setStatus] = useState("");
  const status =
    setting.error ||
    (refresh ? setting.value?.status || message : message || setting.value?.status);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const result = refresh
        ? await runAtomCommand(appAtomRegistry, sync, { environmentId, input: { threadId } })
        : await runAtomCommand(appAtomRegistry, save, {
            environmentId,
            input: { threadId, url: url.trim(), projects },
          });
      setStatus(result._tag === "Success" ? result.value : "Git copy failed.");
      refresh?.();
    } catch {
      setStatus("Git copy failed.");
    }
    setBusy(false);
  }
  return (
    <fieldset disabled={!setting.value || busy} className="grid gap-1">
      {!refresh && (
        <>
          <label>
            Private GitHub repository{" "}
            <input
              value={url}
              placeholder="https://github.com/owner/repo"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <p>Copies are unencrypted in v1. Use a private repo.</p>
          {setting.value?.enterprise && (
            <label>
              <input
                type="checkbox"
                checked={projects}
                onChange={(e) => setProjects(e.target.checked)}
              />{" "}
              Include project notes
            </label>
          )}
          <p>Clear the URL and save to disable Git copy.</p>
        </>
      )}
      {(!refresh || url) && (
        <button type="button" onClick={() => void submit()}>
          {refresh ? "Sync now" : "Save Git copy settings"}
        </button>
      )}
      {status && <p role="status">{status}</p>}
    </fieldset>
  );
}
