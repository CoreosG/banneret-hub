import { useGT } from "gt-react";
import { ScopedSwitch } from "../components/settings/ScopedSwitch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";

export function MemorySettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="memory" title={gt("Memory")}>
      <SettingsRow
        {...setting("use-banneret-memory")}
        serverScoped
        settingKeys={["useBanneretMemory"]}
        description={gt("Enabling Banneret memory turns off Claude and Codex memory in Hub chats.")}
        control={
          <ScopedSwitch
            settingKeys={["useBanneretMemory"]}
            checked={settings.useBanneretMemory}
            onCheckedChange={(checked) => updateSettings({ useBanneretMemory: Boolean(checked) })}
            aria-label={gt("Use Banneret memory")}
          />
        }
      />
    </SettingsSection>
  );
}
