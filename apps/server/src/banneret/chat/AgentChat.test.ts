import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { chatClient, handleId } from "./AgentChat.ts";
import type { RelayEnrolment } from "../relay/Enrolment.ts";

it.effect("consumes the invoking thread's inbox using a signed POST", () =>
  Effect.gen(function* () {
    const body = { items: [], nextCursor: null };
    const sent = vi.fn();
    const signedChat: RelayEnrolment["signedChat"] = (method, path, input) =>
      Effect.sync(() => {
        sent(method, path, input);
        return { status: 200, etag: undefined, bytes: new Uint8Array(), body };
      });
    expect(
      yield* chatClient({ signedChat }, "review-thread", "codex", "desk").consumeInbox,
    ).toEqual(body);
    expect(sent).toHaveBeenCalledExactlyOnceWith("POST", "inbox", {
      asHandle: handleId("review-thread"),
    });
  }),
);
