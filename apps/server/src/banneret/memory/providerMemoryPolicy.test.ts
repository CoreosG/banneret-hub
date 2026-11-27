import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { ServerSettingsService } from "../../serverSettings.ts";
import { providerMemoryPolicy } from "./providerMemoryPolicy.ts";

it.effect.each([undefined, false, true])("provider overrides for useBanneretMemory=%s", (on) =>
  Effect.gen(function* () {
    const policy = yield* Effect.flatten(providerMemoryPolicy).pipe(
      Effect.provide(
        ServerSettingsService.layerTest(on === undefined ? {} : { useBanneretMemory: on }),
      ),
    );
    expect(policy.claudeEnv).toEqual(on ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {});
    expect(policy.codexArgs).toEqual(
      on ? ["-c", "memories.generate_memories=false", "-c", "memories.use_memories=false"] : [],
    );
  }),
);
