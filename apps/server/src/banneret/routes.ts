import * as Layer from "effect/Layer";
import * as WorkspaceFiles from "../workspace/WorkspaceFiles.ts";
import * as BanneretEnrolment from "./relay/Enrolment.ts";
import * as BanneretFacts from "./relay/Facts.ts";
import * as BanneretRelayFeed from "./relay/RelayFeed.ts";
import * as LeaseService from "./lease/LeaseService.ts";

export const files = Layer.merge(
  WorkspaceFiles.layerUploadRoute,
  WorkspaceFiles.layerDownloadRoute,
);
export const services = BanneretRelayFeed.layer.pipe(
  Layer.provideMerge(LeaseService.layer),
  Layer.provideMerge(BanneretEnrolment.layer.pipe(Layer.provide(BanneretFacts.layer))),
);
