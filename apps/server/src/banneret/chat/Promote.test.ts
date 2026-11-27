import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { promote } from "./Promote.ts";
describe("human GitHub promotion", () => {
  it.effect.each(["Ada", "someone-else"])("checks the pinned credential %s", (viewer) =>
    Effect.gen(function* () {
      const comment = vi.fn(() => Effect.void);
      const action = {
        kind: "promote" as const,
        id: "m1",
        host: "github.com",
        scope: "example/project",
        key: "3",
        hubOrigin: "https://hub.example",
      };
      const relay = {
        status: Effect.succeed({
          state: "configured" as const,
          workspaceId: "ent",
          relayOrigin: "https://relay.example",
          me: {
            id: "p_me",
            permissions: [],
            role: { id: "staff", name: "Staff" },
            admission: "member" as const,
            login: "ada",
          },
        }),
        signedChat: () =>
          Effect.succeed({
            status: 200,
            etag: undefined,
            bytes: new Uint8Array(),
            body: { text: "Review this", link: "/channels/c1?message=m1" },
          }),
      };
      const result = yield* promote(
        relay,
        {
          issues: { comment },
          pullRequests: {
            withVerifiedCredential: (_target, use) =>
              use({ accountId: viewer, viewer, credentialFingerprint: "test" }),
          },
        },
        action,
      );
      if (viewer === "Ada") {
        expect(result).toEqual({ ok: true, value: "https://github.com/example/project/issues/3" });
        expect(comment).toHaveBeenCalledExactlyOnceWith({
          cwd: "/",
          host: "github.com",
          scope: "example/project",
          key: "3",
          body: "Review this\n\n[View message in Banneret Hub](https://hub.example/channels/c1?message=m1)",
        });
      } else {
        expect(result.ok).toBe(false);
        expect(comment).not.toHaveBeenCalled();
      }
    }),
  );
});
