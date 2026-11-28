import {
  type Handoff,
  type BanneretTaskRead,
  type BanneretEnrolmentView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { ME, OTHER, leases, newTracker, ref, enrolledAs } from "../lease/leaseTracker.testkit.ts";
import { handoffsForMachine } from "./Handoffs.ts";

it.effect(
  "rechecks the tracker on either Hub before release and take, including after restart",
  () =>
    Effect.gen(function* () {
      const tracker = newTracker();
      const give = yield* leases(tracker);
      const take = yield* leases(tracker, enrolledAs(OTHER));
      yield* give.take(ref);
      const projects = { listShells: () => Effect.succeed([]) };
      const messages: string[] = [];
      const giver = handoffsForMachine(give, projects, () => Effect.void);
      const receiver = () =>
        handoffsForMachine(take, projects, (_input, h) =>
          Effect.sync(() => messages.push(h.note ?? "")),
        );
      const h: Handoff = {
        id: "h1",
        fromMachineId: "desk",
        taskId: "t1",
        from: { id: ME, login: ME },
        to: { id: OTHER, login: OTHER },
        receipts: [],
        note: { goal: "Limit invites", done: "Test", next: "Review" },
        state: "accepted",
        step: "waiting_release",
        machineId: "desk",
        createdAt: "today",
        expiresAt: "tomorrow",
      };
      function device(login: string) {
        const status: BanneretEnrolmentView = {
          state: "configured",
          workspaceId: "company",
          relayOrigin: ref.relayOrigin,
          machineId: "desk",
          me: {
            id: login,
            login,
            admission: "member",
            permissions: [],
            role: { id: "staff", name: "Staff" },
          },
        };
        return {
          origin: ref.relayOrigin,
          status: Effect.succeed(status),
          signedChat: () =>
            Effect.succeed({
              status: 200,
              etag: undefined,
              bytes: new Uint8Array(),
              body: { items: [h], nextCursor: null },
            }),
        };
      }
      const read = () =>
        Effect.succeed<BanneretTaskRead>({
          joined: true,
          fetchedAt: null,
          value: {
            task: {
              id: "t1",
              title: "Invites",
              openedAt: "today",
              closedAt: null,
              ref: { ...ref, url: "https://github.com/example-org/example-app/issues/7" },
            },
            kind: "issue",
            column: "free",
            status: "planned",
            statusWhy: "Open",
            prs: [],
            assignees: [],
            restsOn: [],
          },
        });
      const writes: unknown[] = [];
      const recipient = {
        ...device(OTHER),
        signedChat: (
          method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
          path: string,
          body?: unknown,
        ) =>
          Effect.sync(() => {
            if (method === "POST") writes.push(body);
            const policy = {
              agentWakeDefault: "owner",
              agentsReadMyDms: false,
              agentsPaused: false,
              agentAsks: {
                default: "approve",
                maxSeconds: 90,
                maxTokens: 1000,
                auto: [{ from: { person: h.from }, kinds: ["handoff"] }],
              },
            };
            return {
              status: 200,
              etag: undefined,
              bytes: new Uint8Array(),
              body:
                path === "me/settings"
                  ? policy
                  : {
                      items: path.includes("state=offered") ? [{ ...h, state: "offered" }] : [],
                      nextCursor: null,
                    },
            };
          }),
      };
      yield* receiver().reconcile(recipient, read);
      expect(writes).toEqual([]);
      tracker.viewer = OTHER;
      yield* receiver().reconcile(recipient, read);
      expect(writes).toEqual([{ machineId: "desk", byRule: true }]);
      tracker.viewer = ME;
      const advance = { kind: "advanceHandoff", id: h.id } as const;
      yield* receiver().act(device(OTHER), read, advance);
      expect(tracker.comments).toHaveLength(1);
      yield* giver.act(device(ME), read, advance);
      yield* giver.act(device(ME), read, advance);
      expect(tracker.comments.map((c) => c.body)).toEqual([
        expect.stringContaining("claim:"),
        expect.stringContaining("to @" + OTHER),
      ]);
      const waiting = { ...h, step: "waiting_take" as const };
      const receiving = {
        ...device(OTHER),
        signedChat: () =>
          Effect.succeed({
            status: 200,
            etag: undefined,
            bytes: new Uint8Array(),
            body: { items: [waiting], nextCursor: null },
          }),
      };
      tracker.viewer = OTHER;
      yield* receiver().act(receiving, read, advance);
      yield* receiver().act(receiving, read, advance);
      expect(tracker.assignees).toEqual([OTHER]);
      expect(messages).toEqual(["Goal: Limit invites\nDone: Test\nNext: Review"]);
      expect(tracker.comments).toHaveLength(3);
    }),
);
