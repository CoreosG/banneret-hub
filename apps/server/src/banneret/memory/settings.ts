import { TaskLeaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../../config.ts";

const marker = (stateDir: string) => `${stateDir}/banneret/use-banneret-memory`;

/** Present means off, so a state directory without it keeps Banneret's skills on. */
const noSkills = (stateDir: string) => `${stateDir}/banneret/no-banneret-skills`;

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
  "skills.getSetting": Effect.fn("BanneretSkills.getSetting")(function* () {
    const fs = yield* FileSystem.FileSystem;
    return !(yield* fs.exists(noSkills((yield* ServerConfig).stateDir)));
  }, Effect.mapError(failed)),
  "skills.setSetting": Effect.fn("BanneretSkills.setSetting")(function* ({
    enabled,
  }: {
    enabled: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const dir = (yield* ServerConfig).stateDir;
    if (enabled) {
      yield* fs.remove(noSkills(dir), { force: true });
    } else {
      yield* fs.makeDirectory(`${dir}/banneret`, { recursive: true });
      yield* fs.writeFileString(noSkills(dir), "");
    }
    return enabled;
  }, Effect.mapError(failed)),
};

export const soloSkillsEnabled = memorySettingsHandlers["skills.getSetting"]().pipe(
  Effect.orElseSucceed(() => true),
);
export const memoryEnabled = memorySettingsHandlers["memory.getSetting"]().pipe(
  Effect.orElseSucceed(() => false),
);
export const isPluginMemoryTool = (name: string, prefix = "") =>
  name.startsWith(prefix + "banneret_memory_");
