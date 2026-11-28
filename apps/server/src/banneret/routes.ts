import * as Layer from "effect/Layer";
import * as WorkspaceFiles from "../workspace/WorkspaceFiles.ts";
import * as BanneretEnrolment from "./relay/Enrolment.ts";
import * as BanneretFacts from "./relay/Facts.ts";
import * as BanneretRelayFeed from "./relay/RelayFeed.ts";
import * as LeaseService from "./lease/LeaseService.ts";
import * as Orchestrator from "./Orchestrator.ts";

export const files = Layer.merge(
  WorkspaceFiles.layerUploadRoute,
  WorkspaceFiles.layerDownloadRoute,
);
// The lifecycle sits above the feed: its memory work asks the feed who owns memory. Below it, the
// feed reference would silently answer with its never-joined default.
export const services = Orchestrator.lifecycle.pipe(
  Layer.provideMerge(BanneretRelayFeed.layer),
  Layer.provideMerge(LeaseService.layer),
  Layer.provideMerge(BanneretEnrolment.layer.pipe(Layer.provide(BanneretFacts.layer))),
);
