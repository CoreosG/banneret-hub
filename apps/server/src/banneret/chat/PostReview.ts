import { ChatAsks, type ChannelResult } from "@t3tools/contracts";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RelayEnrolment } from "../relay/Enrolment.ts";

const decodeAsks = Schema.decodeUnknownEffect(ChatAsks);

// Channel RPC only. Resolve text, repository and head from the signed owner's relay.
export const postReview = Effect.fn("Chat.postReview")(function (
  relay: Pick<RelayEnrolment, "status" | "signedChat">,
  api:
    | Pick<
        NonNullable<SourceControlDriverInstance["pullRequests"]>,
        "withVerifiedCredential" | "getChangeRequest" | "submitReview"
      >
    | null
    | undefined,
  id: string,
): Effect.Effect<ChannelResult> {
  return Effect.gen(function* () {
    const viewer = (yield* relay.status).me?.login;
    if (!viewer || !api?.withVerifiedCredential)
      return yield* Effect.fail("Sign in to GitHub to post.");
    let cursor: string | null = null;
    do {
      const page: ChatAsks = yield* relay
        .signedChat(
          "GET",
          "asks?role=owner&state=answered&limit=100" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        )
        .pipe(Effect.flatMap((r) => decodeAsks(r.body)));
      const ask = page.items.find(
        (a) =>
          a.id === id &&
          a.kind === "review" &&
          a.state === "answered" &&
          a.to.kind === "agent" &&
          a.to.owner.login === viewer,
      );
      if (
        ask?.answerMessageId &&
        ask.answer?.verdict &&
        ask.pr &&
        ask.answer.headSha === ask.pr.headSha
      ) {
        yield* relay.signedChat(
          "POST",
          "messages/" + encodeURIComponent(ask.answerMessageId) + "/promote",
        );
        const { pr, answer } = ask;
        const ref = { cwd: "/", host: "github.com", repository: pr.repo, number: pr.number };
        yield* api.withVerifiedCredential(ref, (identity) =>
          Effect.gen(function* () {
            if (identity.viewer.toLowerCase() !== viewer.toLowerCase())
              return yield* Effect.fail("Sign in as the reviewer's owner.");
            const current = yield* api.getChangeRequest(ref);
            if (current.state !== "open" || current.headSha !== pr.headSha)
              return yield* Effect.fail("The pull request changed. Request a fresh review.");
            yield* api.submitReview({
              ...ref,
              verdict: "comment",
              body: answer.verdict + "\n\n" + answer.text,
              comments: [],
              expectedHeadSha: pr.headSha,
            });
          }),
        );
        return "Posted to GitHub";
      }
      cursor = page.nextCursor;
    } while (cursor);
    return yield* Effect.fail("Only the reviewer’s owner can post the result.");
  }).pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (e) => ({
        ok: false as const,
        message: typeof e === "string" ? e : "Could not post the review. Check the pull request.",
      }),
    }),
  );
});
