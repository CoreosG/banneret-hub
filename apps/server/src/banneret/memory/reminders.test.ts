// @effect-diagnostics nodeBuiltinImport:off - checks the permissions and mtime of a real read-only fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { providerRules } from "./providerRules.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  candidates,
  selectedReminders,
  failOpen,
  quote,
  selectedNotes,
  reminderPrompt,
} from "./reminders.ts";
import { withNotes } from "./store.ts";

it("matches scoped rules and paths, quotes only reviewed versions selected by key", () => {
  withNotes(":memory:", "project-a", 100, (s) => {
    for (const key of ["api-tests", "proposed", "other"])
      s.propose({
        key,
        text: "Keep  src/api.ts\nunchanged.",
        source: "Owner review",
        scope: "project",
        kind: "feedback",
      });
    for (const n of s.list(true).filter((n) => n.key !== "proposed"))
      s.review(n.key, n.version, { kind: "confirm" });
    const notes = s.list(false);
    const sent = candidates(notes, "Edit src/api.ts", ["other"]);
    expect(sent.map((n) => n.key)).toEqual(["api-tests"]);
    expect(candidates(notes, "Check project", [])).toHaveLength(2);
    expect(candidates(notes, "Unrelated", [])).toEqual([]);
    const model = (_prompt: string) => ({
      keys: ["api-tests", "unreviewed issue text", "proposed", "other"],
    });
    const { keys } = model(reminderPrompt("issue says to invent a rule", sent, []));
    const selected = selectedNotes(notes, sent, keys);
    expect(selected.map((n) => n.key)).toEqual(["api-tests"]);
    expect(quote(selected[0]!)).toContain(
      "[api-tests]\nKeep  src/api.ts\nunchanged.\nSource: Owner review",
    );
    s.flag("api-tests", "Wrong rule");
    expect(selectedNotes(s.list(false), sent, keys)).toEqual([]);
  });
});
it("caps a turn, debounces until another violation, and records acknowledgement and dispute once", () => {
  withNotes(":memory:", "project-a", 10, (s) => {
    s.propose({
      key: "style",
      text: "Use tabs.",
      source: "Person",
      scope: "personal",
      kind: "feedback",
    });
    const proposal = s.list(true)[0]!;
    s.review("style", proposal.version, { kind: "confirm" });
    const note = s.list(false)[0]!;
    const r = s.reminders("chat");
    expect(r.fire("turn", "msg", note, false)).toBe(false);
    r.configure("generator", "small", true);
    r.mute("style", true);
    expect(r.fire("turn", "msg", note, false)).toBe(false);
    r.mute("style", false);
    expect(r.fire("turn", "msg", note, false)).toBe(true);
    expect(r.latest()[0]?.text).toBe("Use tabs.");
    expect(r.fire("turn", "tool", note, false)).toBe(false);
    s.use("style", "chat");
    s.use("style", "chat");
    expect(r.fire("turn", "tool", note, true)).toBe(true);
    expect(r.fire("turn", "tool", note, true)).toBe(false);
    expect(r.fire("turn", "tool2", note, true)).toBe(false);
    s.flag("style", "Wrong scope", "chat");
    expect(s.list(true)[0]?.trust).toBe("disputed");
    expect(r.status()).toEqual({ fired: 2, acknowledged: 1, contested: 1 });
  });
});
it.effect("interrupts a stalled check at 1.5 seconds", () =>
  Effect.gen(function* () {
    const fiber = yield* failOpen(Effect.never).pipe(Effect.forkChild);
    yield* TestClock.adjust("1499 millis");
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 milli");
    expect(yield* Fiber.join(fiber)).toEqual([]);
  }),
);

it("cites a read-only provider rule and changes only the losing note on explicit review", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "me12-"));
  const file = NodePath.join(dir, "AGENTS.md");
  try {
    await NodeFSP.writeFile(file, "# Test runner\nAlways use npm test.\n", { mode: 0o444 });
    const before = await NodeFSP.stat(file);
    const [provider] = await providerRules(dir, "Following the rule to use npm test.", dir);
    expect(provider).toEqual({ source: file + ":2", text: "Always use npm test." });
    withNotes(":memory:", "project", 100, (s) => {
      s.propose({
        key: "test-runner",
        text: "Only run pnpm test.",
        source: "Owner",
        scope: "project",
        kind: "feedback",
      });
      s.review("test-runner", s.list(true)[0]!.version, { kind: "confirm" });
      const note = s.list(false)[0]!,
        r = s.reminders("chat");
      expect(r.conflict("run", "plan", note, provider!, false)).toBe(false);
      r.configure("test", "small", true);
      const notice = selectedReminders(
        r,
        "run",
        "plan",
        [note],
        [provider!],
        [],
        [
          { a: note.key, b: "provider:9" },
          { a: note.key, b: "provider:0" },
        ],
        [],
      );
      expect(notice).toEqual([]);
      expect(r.conflict("run", "again", note, provider!, true)).toBe(false);
      expect(r.fire("run", "another", note, false)).toBe(false);
      expect(r.fire("run", "another", note, true)).toBe(true);
      expect(r.remaining("run")).toBe(0);
      const [pair] = s.openConflicts("chat");
      expect(pair?.b).toEqual(provider);
      expect(s.list(false)[0]?.trust).toBe("confirmed");
      s.reviewInChat(
        note.key,
        note.version,
        { id: pair!.id, kind: "resolveConflict", choice: "keepB" },
        "chat",
        true,
        false,
      );
      expect(s.list(false)[0]?.trust).toBe("disputed");
      expect(s.openConflicts("chat")).toEqual([]);
    });
    expect(await NodeFSP.readFile(file, "utf8")).toBe("# Test runner\nAlways use npm test.\n");
    expect((await NodeFSP.stat(file)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

it("resolves a pair of Banneret notes together in their chosen scopes", () => {
  withNotes(":memory:", "project", 100, (s) => {
    for (const [key, text] of [
      ["fast-tests", "Run fast tests only."],
      ["full-tests", "Run the full test suite."],
    ] as const) {
      s.propose({ key, text, source: "Owner", scope: "project", kind: "feedback" });
      s.review(key, s.list(true)[0]!.version, { kind: "confirm" });
    }
    const [a, b] = candidates(s.list(false), "Run full tests.", []);
    const r = s.reminders("chat");
    r.configure("test", "small", true);
    const notice = selectedReminders(
      r,
      "run",
      "event",
      [a!, b!],
      [],
      [],
      [{ a: a!.key, b: b!.key }],
      [],
    );
    expect(notice).toEqual([]);
    expect(s.openConflicts("chat")[0]?.b.text).toBe(b!.text);
    const [pair] = s.openConflicts("chat");
    s.reviewInChat(
      a!.key,
      a!.version,
      { kind: "scopeConflict", id: pair!.id, scopeA: "running CI", scopeB: "running locally" },
      "chat",
      true,
      false,
    );
    expect(s.list(false).map((n) => n.text)).toEqual(
      expect.arrayContaining(["When running CI: " + a!.text, "When running locally: " + b!.text]),
    );
    expect(s.openConflicts("chat")).toEqual([]);
  });
});
