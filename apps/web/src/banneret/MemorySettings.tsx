import { PauseSetting } from "./Pause";
import { useSearchableSetting } from "../components/settings/settingsSearch";
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

function MemoryRow({
  environmentId,
  label,
  first,
}: {
  environmentId: EnvironmentId;
  label: string;
  first: boolean;
}) {
  const setting = useSearchableSetting();
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
      title={`${setting("banneret-memory").title} on ${label}`}
      description={`Adds Banneret's shared memory to Hub chats on ${label}. Claude and Codex keep their own memory.`}
      id={first ? setting("banneret-memory").id : undefined}
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
  const setting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  if ((scope.kind !== "all" && scope.kind !== "environment") || !connectedEnvironments.length)
    return null;
  return (
    <>
      <SettingsSection id="automatic-work" title="Automatic work">
        {connectedEnvironments.map(({ environmentId, label }) => (
          <PauseSetting key={environmentId} id={environmentId} label={label} />
        ))}
      </SettingsSection>
      <SettingsSection {...setting("memory")}>
        {connectedEnvironments.map(({ environmentId, label }, index) => (
          <MemoryRow
            first={index === 0}
            key={environmentId}
            environmentId={environmentId}
            label={label}
          />
        ))}
      </SettingsSection>
    </>
  );
}
