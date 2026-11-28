import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ProviderChangeRequestDetail } from "@t3tools/source-control-core/server/PullRequestProvider";
import type { ChatAsk } from "@t3tools/contracts";
import { postReview } from "./PostReview.ts";

it.effect.each([
  ["reviewer", "reviewer", "a", true],
  ["reviewer", "builder", "a", false],
  ["builder", "builder", "a", false],
  ["reviewer", "reviewer", "b", false],
] as const)(
  "posts findings with the owner's credential at the reviewed head (%s, %s, %s)",
  ([login, credential, head, posts]) =>
    Effect.gen(function* () {
      const reviewer = { id: "p_reader", login: "reviewer" };
      const maker = { id: "p_maker", login: "builder" };
      const headSha = "a".repeat(40);
      const ask: ChatAsk = {
        id: "a_review",
        answerMessageId: "m_review",
        to: { kind: "agent", handle: "reader", owner: reviewer },
        choices: [],
        state: "answered",
        kind: "review",
        question: "Check retries",
        pr: { repo: "acme/app", number: 12, headSha },
        depth: 1,
        answer: {
          by: "reader",
          text: "Retry drops one batch. UI unchecked.",
          verdict: "findings",
          headSha,
        },
        receipts: [],
        createdAt: "2026-11-20T10:00:00Z",
        expiresAt: "2026-11-20T14:00:00Z",
        onBehalfOf: maker,
        from: { handle: "builder", owner: maker },
      };
      const submit = vi.fn(() => Effect.void);
      const result = yield* postReview(
        {
          status: Effect.succeed({
            state: "configured",
            workspaceId: "ent",
            relayOrigin: "https://relay.test",
            me: {
              id: "p_me",
              login,
              permissions: [],
              role: { id: "staff", name: "Staff" },
              admission: "member",
            },
          }),
          signedChat: () =>
            Effect.succeed({
              status: 200,
              etag: undefined,
              bytes: new Uint8Array(),
              body: { items: [ask], nextCursor: null },
            }),
        },
        {
          withVerifiedCredential: (_ref, use) =>
            use({ viewer: credential, accountId: "account", credentialFingerprint: "pin" }),
          getChangeRequest: () =>
            Effect.succeed({
              state: "open",
              headSha: head.repeat(40),
            } as ProviderChangeRequestDetail),
          submitReview: submit,
        },
        ask.id,
      );
      expect(result.ok).toBe(posts);
      if (posts)
        expect(submit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ verdict: "comment", number: 12, expectedHeadSha: headSha }),
        );
      else expect(submit).not.toHaveBeenCalled();
    }),
);
