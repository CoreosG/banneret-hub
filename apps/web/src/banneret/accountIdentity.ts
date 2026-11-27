import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";

export function useGitHubLogin(environmentId: EnvironmentId | null) {
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const auth = discovery.data?.sourceControlProviders.find((item) => item.kind === "github")?.auth;
  return auth?.status === "authenticated" ? Option.getOrNull(auth.account) : null;
}

export function accountMatch(login: string | null, relay: string | undefined) {
  return login && relay?.trim() ? login.toLowerCase() === relay.trim().toLowerCase() : null;
}
