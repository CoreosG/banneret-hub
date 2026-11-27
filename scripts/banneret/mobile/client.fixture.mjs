// Executed inside the pinned upstream mobile workspace by check.sh.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
  exchangeRemoteDpopAccessToken,
  resolveRemoteDpopWebSocketConnectionUrl,
} from "../../../../../packages/client-runtime/src/authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../../../../packages/client-runtime/src/environment/descriptor.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "../../../../../packages/client-runtime/src/connection/compatibility.ts";
import { layerRemoteHttpClient } from "../../../../../packages/client-runtime/src/rpc/http.ts";
// oxlint-disable-next-line t3code/no-rpc-permission-bypass -- this wire compatibility test exercises the authenticated stock RPC client directly.
import { makeWsRpcProtocolClient } from "../../../../../packages/client-runtime/src/rpc/protocol.ts";

import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Dpop from "../cloud/dpop";

// Exercise the app signer with the same native substitutes used by its own unit tests.
vi.mock("expo", async () => {
  const { createNodeDpopKeysModule } = await import("../cloud/dpop.testing");
  return { requireNativeModule: createNodeDpopKeysModule };
});
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytes: NodeCrypto.randomBytes,
  digest: async (algorithm, data) =>
    new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer,
}));
vi.mock("expo-secure-store", () => {
  const store = new Map();
  return {
    getItemAsync: async (key) => store.get(key) ?? null,
    setItemAsync: async (key, value) => store.set(key, value),
  };
});

it("pairs and operates a company orchestrator with stock mobile codecs", async () => {
  const { pairUrl, devicePairUrl, workspace, projectId, threadId } = JSON.parse(
    process.env.MOBILE_FIXTURE,
  );
  const { host, code } = parsePairingUrl(extractPairingUrlFromQrPayload(pairUrl));
  const target = resolveRemotePairingTarget({ host, pairingCode: code });
  const clientMetadata = {
    label: "T3 Code Mobile",
    deviceType: "mobile",
    surface: "mobile",
    os: "iOS",
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor(target);
      expect(orchestrationProtocolCompatibilityError(descriptor)).toBeNull();
      const access = yield* bootstrapRemoteBearerSession({ ...target, clientMetadata });
      const socket = appendOrchestrationProtocol(
        yield* resolveRemoteWebSocketConnectionUrl({
          ...target,
          bearerToken: access.access_token,
          clientMetadata,
          connectionMethod: "direct",
        }),
      );
      const params = new URL(socket).searchParams;
      expect(params.get("orchestrationProtocol")).toBe("2");
      expect(params.get("clientCapabilities")).toBe(
        "settingsSecretReferences,httpUsageLimitSources",
      );
      const response = yield* Effect.promise(() =>
        fetch(host + "/api/projects/mutate", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + access.access_token,
            "Content-Type": "application/json",
            "x-t3-orchestration-protocol": "2",
          },
          body: JSON.stringify({
            type: "project.create",
            commandId: NodeCrypto.randomUUID(),
            projectId,
            title: "Company project",
            workspaceRoot: workspace,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const connect = Effect.fn(function* (url) {
        const protocol = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(Socket.layerWebSocket(url)),
            Layer.provide(RpcSerialization.layerJson),
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
        );
        return yield* makeWsRpcProtocolClient.pipe(Effect.provideContext(protocol));
      });
      const setup = yield* connect(socket);
      const handoff = "Use the banneret_start_task prompt.";
      yield* setup["orchestration.launchThread"]({
        threadId,
        projectId,
        commandId: NodeCrypto.randomUUID(),
        title: "Company orchestrator",
        modelSelection: { instanceId: "evalbot", model: "eval/scripted" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: handoff, attachments: [] },
      });
      expect(descriptor.capabilities.accessTokenRenewal).toBe(true);
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const device = resolveRemotePairingTarget({
        pairingUrl: extractPairingUrlFromQrPayload(devicePairUrl),
      });
      const deviceAccess = yield* exchangeRemoteDpopAccessToken({
        ...device,
        clientMetadata,
        dpopProof: yield* signer.createProof({ method: "POST", url: host + "/oauth/token" }),
      });
      const deviceSocket = yield* resolveRemoteDpopWebSocketConnectionUrl({
        ...device,
        accessToken: deviceAccess.access_token,
        createProof: signer.createProof,
        clientMetadata,
        connectionMethod: "direct",
      });
      const rpc = yield* connect(appendOrchestrationProtocol(deviceSocket));
      const [row] = yield* rpc["orchestration.subscribeShell"]({}).pipe(
        Stream.filter((row) => row.kind === "snapshot"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(row.snapshot.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: projectId })]),
      );
      expect(row.snapshot.threads).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: threadId, projectId })]),
      );
      const history = () =>
        Effect.runPromise(rpc["orchestration.getThreadProjection"]({ threadId }));
      const projection = yield* Effect.promise(history);
      expect(projection.messages.map((message) => message.text)).toContain(handoff);
      expect(JSON.stringify(projection)).not.toContain("Private company note");
      yield* rpc["orchestration.dispatchCommand"]({
        type: "message.dispatch",
        commandId: NodeCrypto.randomUUID(),
        threadId,
        messageId: NodeCrypto.randomUUID(),
        text: "Ask before continuing. [[eval:question]]",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "mobile",
      });
      const pending = yield* Effect.promise(() =>
        vi.waitUntil(
          async () =>
            (await history()).runtimeRequests.find(
              (request) => request.kind === "user_input" && request.status === "pending",
            ),
          { timeout: 30000, interval: 150 },
        ),
      );
      yield* rpc["orchestration.dispatchCommand"]({
        type: "runtime-request.respond",
        commandId: NodeCrypto.randomUUID(),
        threadId,
        requestId: pending.id,
        answers: { choice: ["First"] },
      });
      yield* Effect.promise(() =>
        vi.waitFor(
          async () =>
            expect((await history()).runtimeRequests).toContainEqual(
              expect.objectContaining({
                id: pending.id,
                status: "resolved",
                answers: { choice: ["First"] },
              }),
            ),
          { timeout: 15000 },
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        DpopProof.layerSigner({
          keyStore: "expo-secure-store",
          loadOrCreateKey: Dpop.loadOrCreateProofKey(),
        }),
      ),
      Effect.provide(Dpop.layer),
      Effect.provide(layerRemoteHttpClient(fetch)),
    ),
  );
}, 60000);
