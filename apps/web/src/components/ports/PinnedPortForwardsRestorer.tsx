// Banneret Hub: forwards pinned in the Ports panel come back after a restart or reconnect.
import { useEffect, useEffectEvent } from "react";

import { readPinnedForwards } from "~/state/banneretPorts";
import { useEnvironments } from "~/state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardPort,
  usePortForwards,
} from "~/state/portForwards";

export function PinnedPortForwardsRestorer() {
  const { environments } = useEnvironments();
  const forwards = usePortForwards();
  const connectedKey = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId)
    .join("\u0000");

  const restorePins = useEffectEvent(() => {
    for (const pin of readPinnedForwards()) {
      const environment = environments.find((entry) => entry.environmentId === pin.environmentId);
      if (
        !environment ||
        environment.connection.phase !== "connected" ||
        !canForwardPorts(environment) ||
        findPortForward(forwards, pin.environmentId, pin.port)
      ) {
        continue;
      }
      // A forward to this computer itself, or to a closed port, fails quietly; the pin stays.
      void forwardPort(pin.environmentId, pin.port).catch(() => undefined);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-creates pinned desktop port forwards whenever an environment (re)connects
  useEffect(() => {
    if (connectedKey) restorePins();
  }, [connectedKey]);

  return null;
}
