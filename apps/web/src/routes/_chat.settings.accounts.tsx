import { createFileRoute } from "@tanstack/react-router";
import { AccountsSettings } from "../banneret/AccountsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function AccountsPanel() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <AccountsSettings machines={connectedEnvironments} />
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/_chat/settings/accounts")({ component: AccountsPanel });
