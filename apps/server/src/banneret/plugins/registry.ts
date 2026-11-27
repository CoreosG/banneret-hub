// @effect-diagnostics globalFetch:off - manifest discovery rejects redirects and never sends the plugin credential.
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off - hashes the workspace id for a secret-store filename.
import * as NodeCrypto from "node:crypto";
import { TaskLeaseError, parseBanneretRelayAddress } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import { readForMemory } from "../Workspaces.ts";
import { readCapped } from "../relay/RelayClient.ts";

const manifestSchema = Schema.Struct({
  source: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  description: Schema.NonEmptyString,
  auth: Schema.Literals(["per-user-token", "service"]),
  capabilities: Schema.NonEmptyArray(
    Schema.Literals(["tasks", "skills", "memory", "chat", "search", "health"]),
  ),
  toolPrefix: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
  atomicClaim: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (m) =>
      !m.capabilities.includes("tasks") ||
      m.atomicClaim !== undefined ||
      "Task providers must declare atomicClaim.",
  ),
);
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(manifestSchema));
const installation = Schema.Struct({
  manifest: manifestSchema,
  endpoint: Schema.String,
  token: Schema.String,
});
type Installation = typeof installation.Type;
const installations = Schema.fromJsonString(Schema.Array(installation));
const decodeInstalled = Schema.decodeUnknownSync(installations);
const encodeInstalled = Schema.encodeSync(installations);
const fetchManifest = (url: URL) =>
  fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
const failure = (detail: string) => new TaskLeaseError({ reason: "failed", detail });
const isTaskError = Schema.is(TaskLeaseError);
const storeFailure = () => failure("Could not access the plugin settings.");
const key = (id: string) =>
  "solo-plugins-" + NodeCrypto.createHash("sha256").update(id).digest("hex");
const lock = Semaphore.makeUnsafe(1);

function pluginUrl(input: string) {
  const url = new URL(input);
  if (
    !parseBanneretRelayAddress(url.origin).ok ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("Use HTTPS or loopback HTTP without credentials, query or fragment.");
  return url;
}

const secretStore = Effect.serviceOption(Secrets.ServerSecretStore).pipe(
  Effect.flatMap(Option.match({ onNone: () => Secrets.make, onSome: Effect.succeed })),
);
export const readPlugins = Effect.fn("SoloPlugins.read")(function* (id: string) {
  const secret = yield* (yield* secretStore).get(key(id));
  if (Option.isNone(secret)) return [];
  return yield* Effect.try({
    try: () => decodeInstalled(new TextDecoder().decode(secret.value)),
    catch: storeFailure,
  });
}, Effect.mapError(storeFailure));

const checkWorkspace = Effect.fn("SoloPlugins.workspace")(
  function* (workspaceId: string) {
    const workspaces = yield* readForMemory;
    if (!workspaces.some((w) => w.id === workspaceId && w.kind === "solo" && !w.deleted))
      return yield* failure("Select a Solo workspace.");
  },
  Effect.mapError((e) => (isTaskError(e) ? e : storeFailure())),
);

const summary = (items: ReadonlyArray<Installation>) =>
  items.map(({ manifest, endpoint }) => ({ ...manifest, endpoint }));
const change = (
  id: string,
  update: (items: ReadonlyArray<Installation>) => ReadonlyArray<Installation>,
) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      yield* checkWorkspace(id);
      const current = yield* readPlugins(id);
      const next = yield* Effect.try({
        try: () => update(current),
        catch: () => failure("Remove the existing capability owner first."),
      });
      const store = yield* secretStore;
      if (next.length) yield* store.set(key(id), new TextEncoder().encode(encodeInstalled(next)));
      else yield* store.remove(key(id));
      return summary(next);
    }).pipe(Effect.mapError((e) => (isTaskError(e) ? e : storeFailure()))),
  );

export const pluginHandlers = {
  "plugins.list": Effect.fn("SoloPlugins.list")(function* ({
    workspaceId,
  }: {
    workspaceId: string;
  }) {
    yield* checkWorkspace(workspaceId);
    return summary(yield* readPlugins(workspaceId));
  }),
  "plugins.add": Effect.fn("SoloPlugins.add")(function* (input: {
    workspaceId: string;
    endpoint: string;
    manifestUrl?: string | undefined;
    token: Redacted.Redacted<string>;
  }) {
    yield* checkWorkspace(input.workspaceId);
    const { manifest, endpoint } = yield* Effect.tryPromise({
      try: async () => {
        const endpoint = pluginUrl(input.endpoint);
        const manifestUrl = pluginUrl(input.manifestUrl || new URL("plugin.json", endpoint).href);
        const response = await fetchManifest(manifestUrl);
        if (!response.ok) throw new Error();
        const bytes = await readCapped(response, 65536);
        if (!bytes) throw new Error();
        const parsed = decodeManifest(new TextDecoder().decode(bytes));
        return { endpoint: endpoint.href, manifest: parsed };
      },
      catch: () => failure("Could not read plugin.json. Check the endpoint and manifest URL."),
    });
    const token = Redacted.value(input.token);
    if ((manifest.auth === "per-user-token" && !token) || /[\r\n]/.test(token))
      return yield* failure("Enter a valid plugin token.");
    return yield* change(input.workspaceId, (items) => {
      if (
        items.some(
          (p) =>
            p.manifest.source === manifest.source ||
            p.manifest.capabilities.some((c) => manifest.capabilities.includes(c)),
        )
      )
        throw new Error();
      return [...items, { endpoint, manifest, token }];
    });
  }),
  "plugins.remove": ({ workspaceId, source }: { workspaceId: string; source: string }) =>
    change(workspaceId, (items) => items.filter((p) => p.manifest.source !== source)),
};
