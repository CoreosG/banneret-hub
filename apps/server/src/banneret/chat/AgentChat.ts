// @effect-diagnostics nodeBuiltinImport:off - stable synchronous SHA-256 identifiers shared with delivery receipt validation.
import * as NodeCrypto from "node:crypto";
import { ChatThread, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RelayEnrolment } from "../relay/Enrolment.ts";

export const handleId = (thread: string) =>
  "h_" + NodeCrypto.createHash("sha256").update(thread).digest("hex").slice(0, 40);
export const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const decodeId = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const decodeThread = Schema.decodeUnknownEffect(ChatThread);
export function chatClient(
  relay: RelayEnrolment,
  thread: string,
  provider: string,
  machineId: string,
) {
  const asHandle = handleId(thread);
  const request = (
    method: Parameters<RelayEnrolment["signedChat"]>[0],
    path: string,
    body?: unknown,
  ) =>
    relay.signedChat(method, path, body).pipe(
      Effect.map((r) => r.body),
      Effect.mapError((e) => invalid(e.message)),
    );
  const read = (path: string, params: Record<string, string> = {}) =>
    request("GET", path + "?" + new URLSearchParams({ ...params, asHandle }));
  const root = (id: string) =>
    read("threads/" + id, { limit: "1" }).pipe(
      Effect.flatMap(decodeThread),
      Effect.mapError(() => invalid("Cannot read this thread.")),
      Effect.map((r) => r.root),
    );
  return {
    ensure: request("PUT", "handles/" + asHandle, { threadRef: thread, provider, machineId }),
    read,
    root,
    asHandle,
    write: (method: "PUT" | "POST", path: string, body: object) =>
      request(method, path, { ...body, asHandle }).pipe(
        Effect.flatMap((value) =>
          decodeId(value).pipe(
            Effect.mapError(() => invalid("The relay returned no id for this message.")),
          ),
        ),
      ),
  };
}
