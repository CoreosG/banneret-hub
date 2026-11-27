import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { candidates, failOpen, quote, selectedNotes, reminderPrompt } from "./reminders.ts";
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
