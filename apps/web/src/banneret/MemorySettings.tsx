import { MemoryImportSetting } from "./MemoryTransfer";
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:read-memory-setting",
  tag: "memory.getSetting",
});
const write = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:write-memory-setting",
  tag: "memory.setSetting",
});

function MemoryRow({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const writable = useAtomValue(write.permissionAtom(environmentId));
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load this environment's saved setting when its row mounts
  useEffect(() => {
    let current = true;
    void runAtomCommand(appAtomRegistry, read, { environmentId, input: {} }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setEnabled(result.value);
      else setError("Could not read memory setting.");
    });
    return () => {
      current = false;
    };
  }, [environmentId]);
  async function save(next: boolean) {
    setSaving(true);
    const result = await runAtomCommand(appAtomRegistry, write, {
      environmentId,
      input: { enabled: next },
    });
    if (result._tag === "Success") {
      setEnabled(result.value);
      setError(undefined);
    } else setError("Could not save memory setting.");
    setSaving(false);
  }
  return (
    <SettingsRow
      title="Use Banneret memory"
      description={`Enabling Banneret memory turns off Claude and Codex memory in Hub chats on ${label}.`}
      status={error}
      control={
        <>
          {writable && <MemoryImportSetting environmentId={environmentId} />}
          <Switch
            aria-label={`Use Banneret memory on ${label}`}
            disabled={!writable || saving || enabled === undefined}
            checked={enabled ?? false}
            onCheckedChange={save}
          />
        </>
      }
    />
  );
}

export function MemorySettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  if ((scope.kind !== "all" && scope.kind !== "environment") || !connectedEnvironments.length)
    return null;
  return (
    <SettingsSection id="memory" title="Memory">
      {connectedEnvironments.map(({ environmentId, label }) => (
        <MemoryRow key={environmentId} environmentId={environmentId} label={label} />
      ))}
    </SettingsSection>
  );
}
