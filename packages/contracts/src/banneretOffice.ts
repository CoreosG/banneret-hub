import * as S from "effect/Schema";

export const OfficeShare = S.Literals(["hidden", "agents_only", "agents_and_name"]);
export const OfficeSharing = S.Struct({ share: OfficeShare, shareUsage: S.Boolean });
export type OfficeSharing = typeof OfficeSharing.Type;
export const OfficePresence = S.Literals(["available", "focusing", "away", "off"]);
export const officeMeetingUrlValid = (value: string) =>
  URL.canParse(value) &&
  /^https:\/\/[^/@?#\\\s]+(?:[/?#][^\s\\]*)?$/.test(value) &&
  new TextEncoder().encode(value).length <= 300;
export const OfficeEdit = S.Union([
  S.Struct({
    kind: S.Literal("presence"),
    presence: S.optional(OfficePresence),
    status: S.optional(S.NullOr(S.Struct({ text: S.String }))),
  }),
  S.Struct({
    kind: S.Literal("meeting"),
    board: S.NullOr(S.String),
    meetingUrl: S.NullOr(S.String),
  }),
  S.Struct({ kind: S.Literal("sharing"), ...OfficeSharing.fields }),
]);
export type OfficeEdit = typeof OfficeEdit.Type;
export const OfficeHeartbeats = S.Struct({
  asOf: S.String,
  sessions: S.Array(S.Struct({ id: S.String, heardAt: S.String })),
});
export type OfficeHeartbeats = typeof OfficeHeartbeats.Type;
