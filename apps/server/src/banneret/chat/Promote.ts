import { ChatPromotion, type ChannelAction, type ChannelResult } from "@t3tools/contracts";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RelayEnrolment } from "../relay/Enrolment.ts";

const decode = Schema.decodeUnknownEffect(ChatPromotion);
export const promote = Effect.fn("Chat.promote")(function (
  relay: Pick<RelayEnrolment, "status" | "signedChat">,
  driver:
    | {
        pullRequests: Pick<
          NonNullable<SourceControlDriverInstance["pullRequests"]>,
          "withVerifiedCredential"
        > | null;
        issues?: Pick<NonNullable<SourceControlDriverInstance["issues"]>, "comment">;
      }
    | undefined,
  action: Extract<ChannelAction, { kind: "promote" }>,
): Effect.Effect<ChannelResult> {
  return Effect.gen(function* () {
    const viewer = (yield* relay.status).me?.login;
    const verify = driver?.pullRequests?.withVerifiedCredential;
    const comment = driver?.issues?.comment;
    if (!viewer || !verify || !comment) return yield* Effect.fail("Sign in to GitHub to post.");
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(action.scope) ||
      !/^[1-9]\d*$/.test(action.key) ||
      !/^[a-z0-9.-]+$/i.test(action.host)
    )
      return yield* Effect.fail("Choose a GitHub issue.");
    const draft = yield* relay
      .signedChat("POST", "messages/" + action.id + "/promote")
      .pipe(Effect.flatMap((r) => decode(r.body)));
    if (
      !/^\/channels\/[\w-]+\?(thread=[\w-]+&)?message=[\w-]+$/.test(draft.link) ||
      !/^https?:\/\//.test(action.hubOrigin)
    )
      return yield* Effect.fail("Cannot link to this message.");
    const link = yield* Effect.try({
      try: () => new URL(draft.link, action.hubOrigin).href,
      catch: () => "Cannot link to this Hub.",
    });
    const issue = { cwd: "/", host: action.host, scope: action.scope, key: action.key };
    yield* verify({ ...issue, repository: issue.scope }, (identity) =>
      Effect.gen(function* () {
        if (identity.viewer.toLowerCase() !== viewer.toLowerCase())
          return yield* Effect.fail("Your GitHub login must match your company login.");
        yield* comment({
          ...issue,
          body: draft.text + "\n\n[View message in Banneret Hub](" + link + ")",
        });
      }),
    );
    return "https://" + issue.host + "/" + issue.scope + "/issues/" + issue.key;
  }).pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (e) => ({
        ok: false as const,
        message:
          typeof e === "string"
            ? e
            : "Could not post to GitHub. Check the issue before trying again.",
      }),
    }),
  );
});
