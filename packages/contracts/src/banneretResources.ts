import type { Resources, PoolWarnings } from "./banneretPool.ts";
import * as S from "effect/Schema";

const nullableNumber = S.NullOr(S.Number);
const meter = S.Struct({ used: S.Number, limit: nullableNumber, warn: S.Boolean });
const avg = S.Struct({ avg10: S.Number, avg60: S.Number });
const psi = S.Struct({ some: avg, full: avg });
const pressure = S.Struct({ cpu: S.NullOr(psi), io: S.NullOr(psi), memory: S.NullOr(psi) });
const ownPsi = S.NullOr(S.Struct({ sample: psi, limit: S.Number, warn: S.Boolean }));
const reason = S.NullOr(S.Literals(["macos", "windows", "missing_files"]));
const HostPressure = S.Struct({
  pressure,
  busy: S.Boolean,
  memAvailableBytes: nullableNumber,
  poolMemoryUsedBytes: nullableNumber,
  poolMemoryLimitBytes: nullableNumber,
});
const OwnReading = S.Struct({
  measuredAt: S.String,
  notMeasured: reason,
  disk: S.NullOr(meter),
  inodes: S.NullOr(meter),
  memory: S.NullOr(S.Struct({ ...meter.fields, floor: S.Number, oomKills: S.Number })),
  cpu: S.NullOr(
    S.Struct({
      quotaUsec: nullableNumber,
      periodUsec: S.Number,
      throttledPercent: S.Number,
      warn: S.Boolean,
    }),
  ),
  pids: S.NullOr(meter),
  pressure: S.Struct({ cpu: ownPsi, memory: ownPsi, io: ownPsi }),
});
export const ResourceReport = S.Struct({
  recentOomKill: S.Boolean,
  own: OwnReading,
  host: HostPressure,
  cpuCores: nullableNumber,
  coreLimit: nullableNumber,
});
export type ResourceReport = Omit<typeof ResourceReport.Type, "own"> & { readonly own: Resources };
export const WarningPolicy = S.Struct({
  quota_percent: S.Number,
  memory_percent: S.Number,
  cpu_throttled_percent: S.Number,
  pids_percent: S.Number,
  pressure: S.Struct({ memory: S.Number, io: S.Number, cpu: S.Number }),
  host_busy: S.Struct({
    memory_full_avg60: S.Number,
    io_some_avg60: S.Number,
    cpu_some_avg60: S.Number,
  }),
});
export type WarningPolicy = PoolWarnings;
export const PoolResources = S.Struct({
  hosts: S.Array(
    S.Struct({
      hostId: S.String,
      reporting: S.Boolean,
      policy: S.NullOr(S.Struct({ warnings: WarningPolicy })),
      contention: S.NullOr(
        S.Struct({
          ...HostPressure.fields,
          freeSlots: S.Struct({ small: S.Number, large: S.Number }),
        }),
      ),
    }),
  ),
  me: S.Struct({
    workspaces: S.Array(
      S.Struct({
        hostId: S.String,
        resources: S.NullOr(S.Struct({ disk: S.NullOr(meter), inodes: S.NullOr(meter) })),
      }),
    ),
  }),
});
export type PoolResources = typeof PoolResources.Type;
export const FolderSizes = S.Array(S.Struct({ name: S.String, bytes: S.Number }));
