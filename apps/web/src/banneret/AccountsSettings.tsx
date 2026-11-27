import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { usePrimaryEnvironmentId } from "../state/environments";
import { accountMatch, useGitHubLogin } from "./accountIdentity";
import { enrolmentRpc, useEnrolmentViews } from "./enrolmentStore";
import { openWorkspaceDialog } from "./workspacesStore";

function TailscaleLogin({ environmentId }: { environmentId: EnvironmentId }) {
  const [login, setLogin] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read this machine only while Accounts is open
  useEffect(() => {
    let current = true;
    void enrolmentRpc.tailscaleLogin(environmentId).then((result) => {
      if (current) setLogin(result.ok ? result.value : null);
    });
    return () => {
      current = false;
    };
  }, [environmentId]);
  return <p>Tailscale: {login ?? "Not available"}</p>;
}

function MachineAccounts({
  environmentId,
  label,
  local,
}: {
  environmentId: EnvironmentId;
  label: string;
  local: boolean;
}) {
  const login = useGitHubLogin(environmentId);
  const views = useEnrolmentViews(environmentId);
  return (
    <div className="space-y-1 border-b px-4 py-3 text-sm last:border-0">
      <h3 className="font-medium">
        {label}
        {local && " (this machine)"}
      </h3>
      <p>GitHub: {login ?? "Not available"}</p>
      {local && <TailscaleLogin environmentId={environmentId} />}
      {views.map((view) => {
        const match = accountMatch(login, view.me?.login);
        return (
          <div key={view.relayOrigin} className="mt-2">
            <p>
              {view.displayName ?? view.relayOrigin} · Relay:{" "}
              {view.me ? `${view.me.login} · ${view.me.role.name}` : "Not available"} · Machine:{" "}
              {view.label ?? "Not available"}
            </p>
            <p className={match === false ? "text-warning" : "text-muted-foreground"}>
              {match === null
                ? "Account match unavailable"
                : match
                  ? "GitHub account matches"
                  : "GitHub account differs from relay"}
            </p>
            <Button
              variant="link"
              size="sm"
              onClick={() => openWorkspaceDialog({ kind: "machines", origin: view.relayOrigin })}
            >
              Machines
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                openWorkspaceDialog({ kind: "enterprise", origin: view.relayOrigin, environmentId })
              }
            >
              Relay sign-in
            </Button>
          </div>
        );
      })}
    </div>
  );
}

export function AccountsSettings({
  machines,
}: {
  machines: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
}) {
  const primary = usePrimaryEnvironmentId();
  return (
    <SettingsSection id="accounts" title="Accounts">
      {machines.map((machine) => (
        <MachineAccounts
          key={machine.environmentId}
          {...machine}
          local={machine.environmentId === primary}
        />
      ))}
      <a className="block px-4 py-2 text-sm underline" href="/settings/source-control">
        GitHub sign-in settings
      </a>
    </SettingsSection>
  );
}
