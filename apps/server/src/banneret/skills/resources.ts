import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type McpProtocol, McpSchema } from "effect/ai";

// Protocol adapters accept an erased MCP registry. Keep the projection to the two public wire shapes used here.
interface Registry {
  resources: { list(caller: unknown): Effect.Effect<readonly McpSchema.Resource[], Error> };
  tools: {
    call(
      request: typeof McpSchema.CallTool.payloadSchema.Type,
      caller: unknown,
    ): Effect.Effect<{ _tag: string; value?: { structuredContent?: unknown } }, Error>;
  };
}
const catalog = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});

// An MCP registry is shared by all threads. Enumerate private skill names only in the authenticated
// response. The resource template resolves each read against the calling thread's current catalog.
type Adapter = McpProtocol.ProtocolAdapter;
function projectResources(adapter: Adapter): Adapter {
  return {
    ...adapter,
    installHandlers(core: Registry, lifecycle, target) {
      const list = Effect.fn("BanneretSkills.resources")(function* (caller: unknown) {
        const registered = yield* core.resources.list(caller);
        if (!registered.some((r) => r.uri.startsWith("skill://"))) return registered;
        const result = yield* core.tools
          .call({ name: "banneret_skills_list", arguments: {} }, caller)
          .pipe(Effect.orElseSucceed(() => null));
        const content = result?.value?.structuredContent;
        if (!Schema.is(catalog)(content)) return registered;
        return [
          ...registered.filter((r) => !r.uri.startsWith("skill://")),
          ...content.skills.map(
            (skill) =>
              new McpSchema.Resource({
                name: skill.name,
                description: skill.description,
                uri: `skill://${skill.name}/`,
                mimeType: "text/markdown",
              }),
          ),
        ];
      });
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the public protocol adapter erases its installation requirements.
      return adapter.installHandlers(
        { ...core, resources: { ...core.resources, list } },
        lifecycle,
        target,
      );
    },
  };
}

export function withSkillResources([first, ...others]: readonly [Adapter, ...Adapter[]]): [
  Adapter,
  ...Adapter[],
] {
  return [projectResources(first), ...others.map(projectResources)];
}
