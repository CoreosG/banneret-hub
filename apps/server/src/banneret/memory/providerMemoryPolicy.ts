import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../../serverSettings.ts";

export const providerMemoryPolicy = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  const enabled = Option.isSome(service)
    ? service.value.getSettings.pipe(
        Effect.map((settings) => settings.useBanneretMemory),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false);
  return enabled.pipe(
    Effect.map((on) => ({
      claudeEnv: on ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {},
      codexArgs: on
        ? ["-c", "memories.generate_memories=false", "-c", "memories.use_memories=false"]
        : [],
    })),
  );
});
