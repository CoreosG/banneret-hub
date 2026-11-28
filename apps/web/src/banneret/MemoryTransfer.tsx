import { MemoryPreferences } from "./MemoryPreferences";
import { MemoryRepo } from "./MemoryRepo";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { randomUUID } from "../lib/utils";
import { readThreadShell } from "../state/entities";

const loadTargets = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-targets",
  tag: "memory.targets",
});
const add = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:import-memory",
  tag: "memory.importFile",
});
const download = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:export-memory",
  tag: "memory.exportFiles",
});

export function MemoryImportSetting({ environmentId }: { environmentId: EnvironmentId }) {
  const [targets, setTargets] = useState<readonly ThreadId[]>();
  const [selected, setSelected] = useState<ThreadId>();
  const [error, setError] = useState("");
  return (
    <div>
      {!targets ? (
        <button
          type="button"
          onClick={async () => {
            const result = await runAtomCommand(appAtomRegistry, loadTargets, {
              environmentId,
              input: {},
            });
            if (result._tag === "Success") {
              setTargets(result.value);
              if (result.value.length === 1) setSelected(result.value[0]);
            } else setError("Could not load orchestrators.");
          }}
        >
          Import or sync memory
        </button>
      ) : targets.length ? (
        <>
          <label>
            Memory for chat{" "}
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(targets.find((id) => id === e.target.value))}
            >
              <option value="" disabled>
                Choose an orchestrator
              </option>
              {targets.map((threadId) => (
                <option key={threadId} value={threadId}>
                  {readThreadShell({ threadId, environmentId })?.title ?? threadId}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <MemoryPreferences
              key={"preferences-" + selected}
              environmentId={environmentId}
              threadId={selected}
            />
          )}
          {selected && (
            <MemoryTransfer key={selected} environmentId={environmentId} threadId={selected} />
          )}
        </>
      ) : (
        <p>designate an orchestrator chat to manage notes.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

type DirectoryPicker = () => Promise<FileSystemDirectoryHandle>;
async function importFiles({ environmentId, threadId }: ScopedThreadRef, files: File[]) {
  const batch = randomUUID();
  const issues = new Set<string>();
  let count = 0;
  let skipped = 0;
  try {
    for (const file of files.filter(
      (f) =>
        /\.md$/i.test(f.name) &&
        (!f.webkitRelativePath || f.webkitRelativePath.split("/").length === 2),
    )) {
      if (file.size > 65536 || !file.size) {
        issues.add("Skipped an empty or oversized file.");
        continue;
      }
      const content = await file.text();
      if (file.name === "MEMORY.md" && content.startsWith("# Memory\n\n<!-- Banneret index -->"))
        continue;
      const result = await runAtomCommand(appAtomRegistry, add, {
        environmentId,
        input: { threadId, batch, name: file.name, content },
      });
      if (result._tag !== "Success") throw new Error();
      count += result.value.proposed;
      skipped += result.value.skipped;
      if (result.value.reason) issues.add(result.value.reason);
    }
  } catch {
    issues.add("Import interrupted. Select the files again to retry.");
  }
  if (skipped) issues.add(skipped + " existing keys skipped.");
  return [count + " notes proposed. Review them in the orchestrator chat.", ...issues].join(" ");
}
async function exportFiles({ environmentId, threadId }: ScopedThreadRef) {
  try {
    const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker })
      .showDirectoryPicker;
    const parent = picker ? await picker.call(window) : null;
    const result = await runAtomCommand(appAtomRegistry, download, {
      environmentId,
      input: { threadId },
    });
    if (result._tag !== "Success") throw new Error();
    const files = [
      ...result.value,
      {
        name: "MEMORY.md",
        content:
          "# Memory\n\n<!-- Banneret index -->\n" +
          result.value.map((f) => `- [${f.name}](${f.name})`).join("\n"),
      },
    ];
    const folder = "banneret-memory-" + randomUUID();
    if (parent) {
      const directory = await parent.getDirectoryHandle(folder, { create: true });
      for (const file of files) {
        const writer = await (
          await directory.getFileHandle(file.name, { create: true })
        ).createWritable();
        await writer.write(file.content);
        await writer.close();
      }
    } else {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const file of files) zip.file(folder + "/" + file.name, file.content);
      const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "banneret-memory.zip";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    return "Exported " + result.value.length + " notes.";
  } catch {
    return "Export did not finish.";
  }
}
export function MemoryTransfer({
  environmentId,
  threadId,
  refresh,
  revision,
}: ScopedThreadRef & { refresh?: () => void; revision?: number }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function transfer(files?: File[]) {
    setBusy(true);
    const ref = { environmentId, threadId };
    setStatus(await (files ? importFiles(ref, files) : exportFiles(ref)));
    setBusy(false);
    if (files) refresh?.();
  }
  const choose = (directory: boolean) => (
    <label className="cursor-pointer rounded border px-2 py-1">
      {directory ? "Import memory folder" : "Import provider notes"}
      <input
        type="file"
        multiple
        accept=".md"
        className="sr-only"
        {...(directory ? { webkitdirectory: "" } : {})}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void transfer(files);
        }}
      />
    </label>
  );
  return (
    <fieldset disabled={busy} className="flex flex-wrap gap-2 px-2 py-1 text-xs">
      <MemoryRepo
        environmentId={environmentId}
        threadId={threadId}
        refresh={refresh}
        revision={revision}
      />
      {choose(true)}
      {choose(false)}
      {refresh && (
        <button type="button" onClick={() => void transfer()}>
          Export to folder
        </button>
      )}
      {status && <p role="status">{status}</p>}
    </fieldset>
  );
}
