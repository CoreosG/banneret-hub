// Banneret fork: the update dialog's Banneret Hub cell. It names the versions a machine moves between,
// read from the machine's server config, with upstream's kind label ("Server") beneath.
import type { ReactNode } from "react";

import { APP_VERSION } from "~/branding";
import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";
import { useServerConfigs } from "~/state/entities";
import { hubVersionLabel } from "./updateSelection";

export function UpdateHubVersion(props: {
  readonly row: UpdateEverythingRow;
  readonly version: string | null;
  /** Upstream's kind label ("Server"). */
  readonly children: ReactNode;
}) {
  const configs = useServerConfigs();
  const { row } = props;
  const current =
    row.environmentId === null
      ? APP_VERSION
      : configs.get(row.environmentId)?.environment.serverVersion;
  const label = hubVersionLabel(row, current, props.version);
  if (label === null) return props.children;
  return (
    <>
      <span className="block whitespace-nowrap tabular-nums" data-hub-version>
        {label}
      </span>
      {props.children === null ? null : (
        <span className="block text-muted-foreground text-xs">{props.children}</span>
      )}
    </>
  );
}
