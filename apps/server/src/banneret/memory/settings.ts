import { TaskLeaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../../config.ts";

const marker = (stateDir: string) => `${stateDir}/banneret/use-banneret-memory`;

const failed = (e: { message: string }) =>
  new TaskLeaseError({ reason: "failed", detail: e.message });

export const memorySettingsHandlers = {
  "memory.getSetting": Effect.fn("BanneretMemory.getSetting")(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(marker((yield* ServerConfig).stateDir));
  }, Effect.mapError(failed)),
  "memory.setSetting": Effect.fn("BanneretMemory.setSetting")(function* ({
    enabled,
  }: {
    enabled: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const dir = (yield* ServerConfig).stateDir;
    if (enabled) {
      yield* fs.makeDirectory(`${dir}/banneret`, { recursive: true });
      yield* fs.writeFileString(marker(dir), "");
    } else {
      yield* fs.remove(marker(dir), { force: true });
    }
    return enabled;
  }, Effect.mapError(failed)),
};
