import { ServerNpmReleaseError, type ServerNpmReleaseInput } from "@t3tools/contracts";
import { cliReleaseIndexPageUrl, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

const releases = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.optional(Schema.Boolean) }),
);

// The mobile and web RPC contract accepts an exact version or a track. The fork publishes to GitHub.
export const banneretReleaseService = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("Banneret.lookupRelease")(function* (spec: string) {
      for (let page = 1; page <= 10; page++) {
        const rows = yield* http.get(cliReleaseIndexPageUrl(page)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(releases)),
          Effect.timeout("15 seconds"),
          Effect.mapError(
            () =>
              new ServerNpmReleaseError({
                reason: "Could not read Banneret Hub releases from GitHub.",
              }),
          ),
        );
        const version =
          spec === "latest" || spec === "nightly"
            ? newestCliReleaseVersion(rows, spec === "latest" ? "stable" : "nightly")
            : rows.some((row) => !row.draft && row.tag_name === "v" + spec)
              ? spec
              : undefined;
        if (version !== undefined) return { version };
        if (rows.length < 100) break;
      }
      return null;
    }),
  });
  return { get: (input: ServerNpmReleaseInput) => Cache.get(cache, input.spec) };
});
