import { expect, it } from "vite-plus/test";
import { withNotes } from "./store.ts";
it("requires separate messages, merges sources and only raises a dismissed rule on new evidence", () => {
  withNotes(":memory:", "project", 1234, (s) => {
    const raise = (id: string, text: string) =>
      s.correction({ thread: "chat", id, sentence: text });
    const a = "Always run the unit tests before pushing.";
    const b = "Please always run the unit tests before pushing.";
    raise("one", a);
    raise("one", a);
    expect(s.list(true)).toEqual([]);
    raise("two", b);
    const [note] = s.list(true);
    expect(note).toMatchObject({ trust: "proposed", source: expect.stringContaining("Raised 2×") });
    s.review(note!.key, note!.version, { kind: "dismiss" });
    raise("two", b);
    expect(s.list(true)).toEqual([]);
    raise("three", a);
    expect(s.list(true)).toHaveLength(1);
  });
});

it("flushes only this orchestrator's staged instruction sentences on the tenth message or task end", () => {
  withNotes(":memory:", "project", 1234, (s) => {
    const text = "Our release is tomorrow. Always use signed tags.";
    s.configure("one", [], true);
    s.nudge("two", { id: "1", text });
    s.nudge("one", { id: "1", text });
    s.nudge("one", { id: "2", text });
    for (let i = 3; i <= 9; i++) s.nudge("one", { id: String(i), text: "How is the work going?" });
    expect(s.list(true)).toEqual([]);
    s.nudge("one", { id: "10", text: "Thanks." });
    const [proposal] = s.list(true);
    expect(proposal?.source).toContain("Raised 2×");
    expect(proposal?.source).not.toContain("tomorrow");
    s.nudge("one", { id: "11", text });
    s.nudge("one");
    expect(s.list(true)[0]?.source).toContain("Raised 3×");
    s.configure("one", [], false);
    s.nudge("one", { id: "12", text });
    s.nudge("one");
    expect(s.list(true)[0]?.source).toContain("Raised 3×");
  });
});
