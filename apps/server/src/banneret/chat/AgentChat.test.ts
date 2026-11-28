import { RelayCallError } from "../relay/RelayClient.ts";
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

it("forces supervision only on the answering turn and stops at either cap", async () => {
  const { answerPolicy } = await import("./turnPolicy.ts");
  const { capReached, answerMessageId } = await import("./AnswerTurn.ts");
  const policy = {
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: null,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  } as const;
  expect(answerPolicy(answerMessageId("a_one", "d_one"), policy)).toMatchObject({
    runtimePolicy: {
      runtimeMode: "approval-required",
      sandboxPolicy: { type: "readOnly" },
      approvalPolicy: "untrusted",
    },
  });
  expect(answerPolicy("local-message", policy)).toEqual({});
  const caps = { maxTokens: 20, maxSeconds: 5 };
  expect(capReached({ tokens: 19, seconds: 4 }, caps)).toBeUndefined();
  expect(capReached({ tokens: 20, seconds: 4 }, caps)).toBe("token_cap");
  expect(capReached({ tokens: 19, seconds: 5 }, caps)).toBe("time_cap");
});

it.effect("explains why the maker's owner cannot check the pull request", () =>
  Effect.gen(function* () {
    const client = chatClient(
      {
        signedChat: () =>
          Effect.fail(
            new RelayCallError({
              status: 403,
              code: "review_same_owner",
              message: "Ask refused",
              retryable: false,
            }),
          ),
      },
      "thread",
      "codex",
      "desk",
    );
    const refusal = yield* client.write("POST", "asks", {}).pipe(Effect.flip);
    expect(refusal.message).toMatch(/owner wrote the pull request or holds the task lease/);
  }),
);
