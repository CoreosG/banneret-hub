import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as WorkspaceFiles from "../workspace/WorkspaceFiles.ts";
import * as ListeningPorts from "../preview/ListeningPorts.ts";
import { pauseRpcHandlers } from "./Pause.ts";
import * as BanneretWorkspaces from "./Workspaces.ts";
import * as BanneretEnrolment from "./relay/Enrolment.ts";
import * as BanneretRelayFeed from "./relay/RelayFeed.ts";
import * as LeaseService from "./lease/LeaseService.ts";

export const handlers = Effect.fnUntraced(function* (
  currentSessionId: AuthSessionId,
  serverAuth: EnvironmentAuth.EnvironmentAuth["Service"],
) {
  return {
    ...WorkspaceFiles.rpcHandlers,
    ...ListeningPorts.rpcHandlers,
    ...(yield* pauseRpcHandlers),
    ...BanneretWorkspaces.rpcHandlers,
    ...BanneretEnrolment.rpcHandlers,
    ...BanneretRelayFeed.rpcHandlers,
    ...LeaseService.sessionHandlers(currentSessionId, serverAuth),
  };
});

// Capture the host services before building each authenticated session's RPC layer.
export const sessionServices = Effect.gen(function* () {
  const banneretEnrolment = yield* BanneretEnrolment.BanneretEnrolment;
  const banneretRelayFeed = yield* BanneretRelayFeed.BanneretRelayFeed;
  const leaseService = yield* LeaseService.LeaseService;
  return Layer.mergeAll(
    Layer.succeed(BanneretEnrolment.BanneretEnrolment, banneretEnrolment),
    Layer.succeed(BanneretRelayFeed.BanneretRelayFeed, banneretRelayFeed),
    Layer.succeed(LeaseService.LeaseService, leaseService),
  );
});
