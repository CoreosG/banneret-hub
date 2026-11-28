import { PauseSetting } from "./Pause";
import { AgentWakeSetting } from "./chat/AgentSettings";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { MemoryImportSetting } from "./MemoryTransfer";
import { OwnedElsewhere } from "./OwnedElsewhere";
import { CompanySignInSettings } from "./SourceSignIns";
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
const readSkills = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:read-skills-setting",
  tag: "skills.getSetting",
});
const writeSkills = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:write-skills-setting",
  tag: "skills.setSetting",
});

/** One machine's saved switch: read when its row mounts, replaced only by the server's answer. */
function useMachineSwitch(
  environmentId: EnvironmentId,
  commands: { readonly read: typeof read; readonly write: typeof write },
  failures: { readonly read: string; readonly save: string },
) {
  const writable = useAtomValue(commands.write.permissionAtom(environmentId));
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- load this environment's saved setting when its row mounts
  useEffect(() => {
    let current = true;
    void runAtomCommand(appAtomRegistry, commands.read, { environmentId, input: {} }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Success") setEnabled(result.value);
        else setError(failures.read);
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, commands.read, failures.read]);
  async function save(next: boolean) {
    setSaving(true);
    const result = await runAtomCommand(appAtomRegistry, commands.write, {
      environmentId,
      input: { enabled: next },
    });
    if (result._tag === "Success") {
      setEnabled(result.value);
      setError(undefined);
    } else setError(failures.save);
    setSaving(false);
  }
  return {
    writable,
    status: error,
    checked: enabled ?? false,
    disabled: !writable || saving || enabled === undefined,
    onCheckedChange: save,
  };
}

const memoryCommands = { read, write };
const memoryFailures = {
  read: "Could not read memory setting.",
  save: "Could not save memory setting.",
};
const skillsCommands = { read: readSkills, write: writeSkills };
const skillsFailures = {
  read: "Could not read skills setting.",
  save: "Could not save skills setting.",
};

function SkillsRow({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const { status, checked, disabled, onCheckedChange } = useMachineSwitch(
    environmentId,
    skillsCommands,
    skillsFailures,
  );
  return (
    <SettingsRow
      title={`Banneret skills on ${label}`}
      description={`Offers Banneret's skill tools to Solo chats on ${label}. Turn this off when your own server provides skills. Company chats follow the company's relay.`}
      status={status}
      control={
        <Switch
          aria-label={`Offer Banneret skills on ${label}`}
          disabled={disabled}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}

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
  const { writable, status, checked, disabled, onCheckedChange } = useMachineSwitch(
    environmentId,
    memoryCommands,
    memoryFailures,
  );
  return (
    <SettingsRow
      title={`${setting("banneret-memory").title} on ${label}`}
      description={`Adds Banneret's shared memory to Hub chats on ${label}. Claude and Codex keep their own memory.`}
      id={first ? setting("banneret-memory").id : undefined}
      status={status}
      control={
        <>
          {writable && <MemoryImportSetting environmentId={environmentId} />}
          <Switch
            aria-label={`Use Banneret memory on ${label}`}
            disabled={disabled}
            checked={checked}
            onCheckedChange={onCheckedChange}
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
      <AgentWakeSetting />
      <SettingsSection {...setting("memory")}>
        <OwnedElsewhere capabilities={["memory", "skills", "search"]} className="m-3" />
        {connectedEnvironments.map(({ environmentId, label }, index) => (
          <MemoryRow
            first={index === 0}
            key={environmentId}
            environmentId={environmentId}
            label={label}
          />
        ))}
        {connectedEnvironments.map(({ environmentId, label }) => (
          <SkillsRow key={environmentId} environmentId={environmentId} label={label} />
        ))}
      </SettingsSection>
      <CompanySignInSettings />
    </>
  );
}
