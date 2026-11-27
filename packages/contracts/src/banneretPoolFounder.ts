import * as S from "effect/Schema";

const size = S.Struct({ cpu: S.Number, memory: S.String, disk: S.String });
export const PoolCeilings = S.Struct({
  limits: S.Struct({
    id: S.String,
    level: S.Literals(["staff", "community"]),
    workspaces: S.Struct({
      max: S.Number,
      each: S.Struct({
        cpu: S.Number,
        tasks: S.Number,
        disk: S.String,
        memory_floor: S.String,
        memory_max: S.String,
      }),
    }),
    sandbox_slots: S.Struct({ small: S.Number, large: S.Number }),
  }),
  sizes: S.Struct({ small: size, large: size }),
});
export type PoolCeilings = typeof PoolCeilings.Type;
export const PoolFounderAction = S.Union([
  S.Struct({ action: S.Literal("confirm"), pairingId: S.String, code: S.String }),
  S.Struct({ action: S.Literal("refuse"), pairingId: S.String }),
  S.Struct({ action: S.Literal("approve"), requestId: S.String }),
  S.Struct({ action: S.Literal("limits"), requested: PoolCeilings }),
]);
export type PoolFounderAction = typeof PoolFounderAction.Type;
export const PoolFounderView = S.Struct({
  enrolments: S.Array(S.Struct({ pairingId: S.String, hostId: S.String })),
  hosts: S.Array(
    S.Struct({
      requested: PoolCeilings,
      local: S.NullOr(PoolCeilings),
      effective: S.NullOr(PoolCeilings),
    }),
  ),
  requests: S.Array(
    S.Struct({
      requestId: S.String,
      hostId: S.String,
      personId: S.String,
      state: S.Literals(["asked", "approved"]),
    }),
  ),
});
export type PoolFounderView = typeof PoolFounderView.Type;
