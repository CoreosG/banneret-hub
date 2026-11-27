import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../../config.ts";
import { memorySettingsHandlers, providerMemoryPolicy } from "./providerMemoryPolicy.ts";

it.effect("reads the saved opt-in at each provider launch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateDir } = yield* Config.ServerConfig;
    expect(yield* memorySettingsHandlers["memory.getSetting"]()).toBe(false);
    for (const enabled of [false, true, false]) {
      yield* memorySettingsHandlers["memory.setSetting"]({ enabled });
      expect(yield* memorySettingsHandlers["memory.getSetting"]()).toBe(enabled);
      const policy = yield* providerMemoryPolicy(fs, stateDir);
      expect(policy.claudeEnv).toEqual(enabled ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {});
      expect(policy.codexArgs).toEqual(
        enabled
          ? ["-c", "memories.generate_memories=false", "-c", "memories.use_memories=false"]
          : [],
      );
    }
  }).pipe(
    Effect.provide(
      Config.layerTest(process.cwd(), { prefix: "banneret-memory-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
