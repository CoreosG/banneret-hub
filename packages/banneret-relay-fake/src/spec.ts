// @effect-diagnostics nodeBuiltinImport:off - a plain Node test double: it reads the canonical spec from disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as Yaml from "yaml";

/** The canonical contract: docs/banneret/relay-v1/ at the repository root. */
export const specDirectory = NodeURL.fileURLToPath(
  new URL("../../../docs/banneret/relay-v1/", import.meta.url),
);

const specUrl = "https://relay-v1.invalid/openapi.json";

export type SchemaName =
  | "Capabilities"
  | "EnrolStartRequest"
  | "EnrolStartResponse"
  | "EnrolPollRequest"
  | "EnrolPollResponse"
  | "FactsRequest"
  | "FactsResponse"
  | "MachinesPage"
  | "NeedsPage"
  | "RepositoriesPage"
  | "Today"
  | "Error"
  | "NeedsChangedEvent"
  | "MentionEvent"
  | "BundleChangedEvent"
  | "StaffRemovedEvent"
  | "CapabilitiesChangedEvent"
  | "ResetEvent"
  | "SnapshotHead"
  | "SnapshotNeeds"
  | "HealthBlock"
  | "SnapshotWork"
  | "SnapshotMachines"
  | "SnapshotRepositories"
  | "SnapshotBoard"
  | "SnapshotMap"
  | "FeedPage"
  | "GraveyardPage"
  | "TaskRead"
  | "Id";

export interface SpecValidator {
  /** Every schema under components/schemas. */
  readonly schemaNames: ReadonlyArray<string>;
  /** Null when `value` is valid, otherwise the first errors in plain words. */
  readonly check: (name: string, value: unknown) => string | null;
}

const describe = (errors: ReadonlyArray<ErrorObject> | null | undefined) =>
  (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");

export const readOpenApi = (): Record<string, unknown> =>
  Yaml.parse(NodeFS.readFileSync(`${specDirectory}openapi.yaml`, "utf8")) as Record<
    string,
    unknown
  >;

export const loadSpec = (): SpecValidator => {
  const doc = readOpenApi();
  const components = doc.components as { schemas: Record<string, unknown> };
  const schemas = components.schemas;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addSchema({ $id: specUrl, components: { schemas } });
  const compiled = new Map<string, ValidateFunction>();
  for (const name of Object.keys(schemas)) {
    const validate = ajv.getSchema(`${specUrl}#/components/schemas/${name}`);
    if (!validate) throw new Error(`relay-v1 schema ${name} did not compile`);
    compiled.set(name, validate);
  }
  return {
    schemaNames: [...compiled.keys()],
    check: (name, value) => {
      const validate = compiled.get(name);
      if (!validate) throw new Error(`relay-v1 has no schema ${name}`);
      return validate(value) ? null : describe(validate.errors);
    },
  };
};

/** The valid examples and the schema each one shows; the same map as the Go contract test. */
export const exampleSchemas: Readonly<Record<string, SchemaName>> = {
  "capabilities-public.json": "Capabilities",
  "capabilities.json": "Capabilities",
  "enroll-start-request.json": "EnrolStartRequest",
  "enroll-start-response.json": "EnrolStartResponse",
  "enroll-poll-request.json": "EnrolPollRequest",
  "enroll-poll-awaiting.json": "EnrolPollResponse",
  "enroll-poll-approved.json": "EnrolPollResponse",
  "enroll-poll-refused.json": "EnrolPollResponse",
  "enroll-poll-expired.json": "EnrolPollResponse",
  "facts-request.json": "FactsRequest",
  "facts-response.json": "FactsResponse",
  "machines.json": "MachinesPage",
  "needs.json": "NeedsPage",
  "repositories.json": "RepositoriesPage",
  "today.json": "Today",
  "error.json": "Error",
  "event-needs-changed.json": "NeedsChangedEvent",
  "event-mention.json": "MentionEvent",
  "event-bundle-changed.json": "BundleChangedEvent",
  "event-staff-removed.json": "StaffRemovedEvent",
  "event-capabilities-changed.json": "CapabilitiesChangedEvent",
  "event-reset.json": "ResetEvent",
  "snapshot-head.json": "SnapshotHead",
  "snapshot-head-no-repositories.json": "SnapshotHead",
  "snapshot-needs.json": "SnapshotNeeds",
  "snapshot-health.json": "HealthBlock",
  "snapshot-work.json": "SnapshotWork",
  "snapshot-machines.json": "SnapshotMachines",
  "snapshot-repositories.json": "SnapshotRepositories",
  "snapshot-board.json": "SnapshotBoard",
  "snapshot-map.json": "SnapshotMap",
  "snapshot-map-not-measured.json": "SnapshotMap",
  "snapshot-feed.json": "FeedPage",
  "snapshot-graveyard.json": "GraveyardPage",
  "task.json": "TaskRead",
  "task-checked-ignored.json": "TaskRead",
};

/** Invalid examples are refused facts, except the enrolment ones; the same rule as the Go contract test. */
export const invalidExampleSchema = (file: string): SchemaName =>
  file.startsWith("enroll-poll")
    ? "EnrolPollResponse"
    : file.startsWith("enroll-start")
      ? "EnrolStartRequest"
      : file.startsWith("repositories-")
        ? "RepositoriesPage"
        : file.startsWith("snapshot-head")
          ? "SnapshotHead"
          : file.startsWith("snapshot-machines")
            ? "SnapshotMachines"
            : file.startsWith("snapshot-repositories")
              ? "SnapshotRepositories"
              : file.startsWith("snapshot-work")
                ? "SnapshotWork"
                : file.startsWith("snapshot-board")
                  ? "SnapshotBoard"
                  : file.startsWith("snapshot-map")
                    ? "SnapshotMap"
                    : file.startsWith("snapshot-feed")
                      ? "FeedPage"
                      : file.startsWith("snapshot-graveyard")
                        ? "GraveyardPage"
                        : file.startsWith("task-")
                          ? "TaskRead"
                          : file.startsWith("today-")
                            ? "Today"
                            : "FactsRequest";

export const listExamples = (sub: "" | "invalid/"): ReadonlyArray<string> =>
  NodeFS.readdirSync(`${specDirectory}examples/${sub}`)
    // stage-plan.json follows stage-plan.schema.json, not openapi.yaml, so it has its own contract test.
    .filter((file) => file.endsWith(".json") && !file.startsWith("stage-plan"))
    .toSorted();

export const readExample = (file: string): unknown =>
  JSON.parse(NodeFS.readFileSync(`${specDirectory}examples/${file}`, "utf8"));
