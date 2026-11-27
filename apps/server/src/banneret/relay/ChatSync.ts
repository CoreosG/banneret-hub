import {
  callChannel,
  ChatChanges,
  type ChannelAction,
  type ChannelResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayCallError } from "./RelayClient.ts";
import type { RelayEnrolment } from "./Enrolment.ts";
const decodeChatChanges = Schema.decodeUnknownEffect(ChatChanges);

export const chatUnavailable: ChannelResult = {
  ok: false,
  message: "Company chat is unavailable.",
};

export function channelAction(
  call: RelayEnrolment["signedChat"],
  action: ChannelAction,
): Effect.Effect<ChannelResult> {
  return callChannel(action, call).pipe(
    Effect.match({
      onSuccess: (r) => ({ ok: true as const, value: r.body }),
      onFailure: (e) => ({ ok: false as const, message: e.message }),
    }),
  );
}

// State (in memory) | Event | Transition
// Off | join or restart | drain from zero. Any | leave | clear cursor and turn off.
// Following | contiguous inline change | advance. Gap, hint, reset or reconnect | drain from cursor.
// Draining | success or pruning | publish watermark and reload views. Failure | reconnect and retry.
export const catchUpChat = Effect.fn("ChatSync.catchUp")(function* (
  relay: RelayEnrolment,
  after: number,
) {
  for (;;) {
    const reply = yield* relay.signedGet("/relay/v1/chat/changes?limit=100&after=" + after);
    const page = yield* decodeChatChanges(reply.body).pipe(
      Effect.mapError(
        () =>
          new RelayCallError({
            status: 0,
            code: "bad_response",
            retryable: true,
            message: "Invalid chat changes.",
          }),
      ),
    );
    if (page.resync || page.items.length < 100 || page.nextSeq <= after) return page.nextSeq;
    after = page.nextSeq;
  }
});
