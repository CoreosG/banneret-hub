// @effect-diagnostics nodeBuiltinImport:off - isolated git repositories and an SSH transport fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  type Handoff,
  type BanneretTaskRead,
  type BanneretEnrolmentView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { ME, OTHER, leases, newTracker, ref, enrolledAs } from "../lease/leaseTracker.testkit.ts";
import { handoffsForMachine } from "./Handoffs.ts";
import { pushedCheckout } from "./pushedCheckout.testkit.ts";
import { RelayCallError } from "../relay/RelayClient.ts";

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
      yield* receiver().act(device(OTHER), read, advance, false);
      expect(tracker.comments).toHaveLength(1);
      yield* giver.act(device(ME), read, advance, false);
      yield* giver.act(device(ME), read, advance, false);
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
      yield* receiver().act(receiving, read, advance, false);
      yield* receiver().act(receiving, read, advance, false);
      expect(tracker.assignees).toEqual([OTHER]);
      expect(messages).toEqual(["Goal: Limit invites\nDone: Test\nNext: Review"]);
      expect(tracker.comments).toHaveLength(3);
    }),
);

it.effect("opens the task thread before an offer only on a relay with task threads", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "handoff-offer-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const { remoteUrl, head } = pushedCheckout(root);
    const tracker = newTracker();
    const give = yield* leases(tracker);
    yield* give.take(ref);
    // Only the checkout and its remote are read from a project here.
    const shell = { workspaceRoot: root, repositoryIdentity: { locator: { remoteUrl } } };
    const projects = { listShells: () => Effect.succeed([shell] as never) };
    const giver = handoffsForMachine(give, projects, () => Effect.void);
    const calls: string[] = [];
    let noThread = false;
    const relay = {
      origin: ref.relayOrigin,
      status: Effect.succeed<BanneretEnrolmentView>({ state: "none" } as BanneretEnrolmentView),
      signedChat: (method: string, path: string) =>
        Effect.suspend(() => {
          calls.push(method + " " + path);
          return noThread && method === "PUT"
            ? Effect.fail(
                new RelayCallError({
                  status: 404,
                  code: "not_found",
                  message: "This task has no chat thread.",
                  retryable: false,
                }),
              )
            : Effect.succeed({ status: 200, etag: undefined, bytes: new Uint8Array(), body: {} });
        }),
    };
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
          column: "taken",
          status: "planned",
          statusWhy: "Open",
          prs: [],
          assignees: [],
          restsOn: [],
        },
      });
    const offer = {
      kind: "offerHandoff",
      offer: {
        taskId: "t1",
        to: { id: OTHER, login: OTHER },
        note: { goal: "Limit invites", done: "Test", next: "Review" },
        branch: "work",
        headSha: head,
        key: "offer",
      },
    } as const;
    expect(yield* giver.act(relay, read, offer, false)).toMatchObject({ ok: true });
    expect(calls).toEqual(["POST handoffs"]);
    calls.length = 0;
    expect(yield* giver.act(relay, read, offer, true)).toMatchObject({ ok: true });
    expect(calls).toEqual(["PUT tasks/t1/thread", "POST handoffs"]);
    // The relay may refuse the task a thread. The offer still goes.
    calls.length = 0;
    noThread = true;
    expect(yield* giver.act(relay, read, offer, true)).toMatchObject({ ok: true });
    expect(calls).toEqual(["PUT tasks/t1/thread", "POST handoffs"]);
  }),
);
