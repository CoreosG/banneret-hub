import { describe, expect, it } from "vite-plus/test";
import claudeAgent from "./profiles/claudeAgent.json" with { type: "json" };
import codex from "./profiles/codex.json" with { type: "json" };
import {
  builtInProviderProfileIds,
  checkProviderProfile,
  instructionLevels,
  instructionTrees,
  parseProviderProfile,
  parseProviderProfileText,
  providerProfile,
  resolveInstructions,
  unknownProviderProfile,
} from "./index.ts";

/** A copy of a built-in profile's data with one change. */
function draft(change: (profile: any) => void, base: unknown = claudeAgent): unknown {
  const copy = structuredClone(base);
  change(copy);
  return copy;
}
const unknownFact = { unknown: "Not read." };

describe.each([...builtInProviderProfileIds, "someAcpAgent"])("conformance: %s", (id) => {
  const report = checkProviderProfile(providerProfile(id));

  it("passes every check that can run today", () => {
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.passed).toBe(true);
    expect(
      report.checks.filter((check) => check.status === "pass").map((check) => check.name),
    ).toEqual([
      "shape",
      "instructions: mixed tree",
      "instructions: agentsOnly tree",
      "hooks: maps",
    ]);
  });
  it("says which checks it could not run", () => {
    expect(
      report.checks.filter((check) => check.status === "skip").map((check) => check.name),
    ).toEqual([
      "hooks: same verdict through the adapter",
      "memory: the Hub applies the off switch",
    ]);
  });
});

describe("registry", () => {
  it("ships full profiles for Claude Code and Codex", () => {
    expect(builtInProviderProfileIds).toEqual(["claudeAgent", "codex"]);
  });
  it.each(["fx", "constructor", "toString"])(
    "gives %s the unknown profile, never another provider's",
    (id) => {
      expect(providerProfile(id)).toEqual(unknownProviderProfile(id));
      expect(providerProfile(id).sources).toEqual({});
    },
  );
});

describe("unknown stays unknown", () => {
  it.each(Object.entries(instructionTrees))(
    "reports every level as unknown on the %s tree, not as reading nothing",
    (_name, tree) => {
      expect(resolveInstructions(providerProfile("fx"), tree)).toEqual({
        atStart: [],
        onDemand: [],
        undetermined: [],
        unknownLevels: [...instructionLevels],
      });
    },
  );
  it.each([
    ["the personal file names", ["user"], (p: any) => (p.instructions.user = unknownFact)],
    ["the home folder", ["user"], (p: any) => (p.instructions.homeFolder = unknownFact)],
    [
      "the project fallback",
      ["project", "subdirectory"],
      (p: any) => (p.instructions.project.fallback = unknownFact),
    ],
    ["folders below", ["subdirectory"], (p: any) => (p.instructions.subdirectory = unknownFact)],
    [
      "the order",
      ["managed", "user", "project"],
      (p: any) => (p.instructions.precedence = unknownFact),
    ],
  ])("marks only what depends on %s", (_name, levels, change) => {
    const profile = parseProviderProfile(draft(change));
    expect(resolveInstructions(profile, instructionTrees.agentsOnly).unknownLevels).toEqual(levels);
  });
});

describe("resolver", () => {
  it("does not guess about folders between the start folder and a touched file", () => {
    const resolved = resolveInstructions(providerProfile("claudeAgent"), {
      home: "/home/ada",
      startFolder: "/repo",
      files: ["/repo/a/CLAUDE.md", "/repo/a/b/CLAUDE.md", "/repo/a/b/x.ts", "/other/CLAUDE.md"],
      emptyFiles: [],
      actions: [
        { path: "/repo/a/b/x.ts", action: "write" },
        { path: "/other/y.ts", action: "read" },
      ],
    });
    expect(resolved.onDemand).toEqual(["/repo/a/b/CLAUDE.md"]);
    expect(resolved.undetermined).toEqual(["/repo/a/CLAUDE.md"]);
  });
  it("reads only the start folder when there is no project root", () => {
    const resolved = resolveInstructions(providerProfile("codex"), {
      home: "/home/ada",
      startFolder: "/notes/today",
      files: ["/notes/AGENTS.md", "/notes/today/AGENTS.md"],
      emptyFiles: [],
      actions: [],
    });
    expect(resolved.atStart).toEqual(["/notes/today/AGENTS.md"]);
  });
});

describe("conformance catches", () => {
  const failures = (data: unknown) =>
    checkProviderProfile(data)
      .checks.filter((check) => check.status === "fail")
      .map((check) => `${check.name}: ${check.hint}`)
      .join("\n");

  it("facts that disagree with the promised file list", () => {
    expect(failures(draft((p) => (p.instructions.user.value.take = "all"), codex))).toMatch(
      /instructions: agentsOnly tree: .*AGENTS\.override\.md/,
    );
  });
  it("a list promised in the wrong order", () => {
    expect(failures(draft((p) => p.conformance.instructionLoads.mixed.atStart.reverse()))).toMatch(
      /instructions: mixed tree/,
    );
  });
  it("a shared event that is silently dropped", () => {
    expect(failures(draft((p) => p.hooks.cannotCarry.value.shift()))).toMatch(
      /"interrupt" is neither mapped nor listed/,
    );
  });
  it("a provider that cannot ask and does not say so", () => {
    expect(
      failures(
        draft((p) => {
          p.hooks.cannotCarry.value = p.hooks.cannotCarry.value.filter(
            (entry: any) => entry.name !== "ask",
          );
        }, codex),
      ),
    ).toMatch(/must list the "ask" decision/);
  });
  it("one tool name in two rows", () => {
    expect(failures(draft((p) => p.hooks.tools.value[0].names.push("Edit"), codex))).toMatch(
      /"Edit" belongs to two rows/,
    );
  });
  it("a malformed profile, with the reason", () => {
    expect(checkProviderProfile({}).passed).toBe(false);
    expect(failures({})).toMatch(/shape: .*instructions: /s);
  });
});

describe("loader rejects", () => {
  it.each([
    [
      "a value without a source",
      (p: any) => delete p.instructions.user.from,
      "instructions.user.from: ",
    ],
    ["an empty source list", (p: any) => (p.memory.learns.from = []), "memory.learns.from: "],
    [
      "a source id that does not exist",
      (p: any) => (p.memory.learns.from = ["nowhere"]),
      'memory.learns: cites "nowhere", which is not in sources',
    ],
    [
      "a source nothing cites",
      (p: any) => (p.sources.spare = { url: "https://example.org", checked: "2026-11-28" }),
      "sources.spare: no fact cites it",
    ],
    ["a bad date", (p: any) => (p.sources["memory-page"].checked = "today"), "sources.memory-page"],
    [
      "a misspelled key",
      (p: any) => (p.instructions.project.fallbak = p.instructions.project.fallback),
      'instructions.project: Unrecognized key: "fallbak"',
    ],
    [
      "a helper the Hub does not have",
      (p: any) => (p.hooks.tools.value[1].paths.helper = "runMyScript"),
      "hooks.tools.value.1.paths.helper: ",
    ],
    [
      "an unknown fact that also has a value",
      (p: any) => (p.memory.learns = { unknown: "x", value: true }),
      "memory.learns",
    ],
    [
      "a missing source on an unknown fact",
      (p: any) => (p.skills.sharedAgentsFolder = { unknown: "x", from: ["nowhere"] }),
      'skills.sharedAgentsFolder: cites "nowhere"',
    ],
    [
      "a path that leaves its folder",
      (p: any) => (p.instructions.user.value.names = ["../secrets"]),
      "without `..`",
    ],
    [
      "a walk with no start folder",
      (p: any) =>
        (p.instructions.project.walk.value = {
          startsAt: "projectRoot",
          stopsAt: "filesystemRoot",
        }),
      "Exactly one end of the walk must be startFolder.",
    ],
    ["a missing part", (p: any) => delete p.mcp, "mcp: "],
    [
      "an event outside the shared list",
      (p: any) => (p.hooks.events.value[0].common = "sessionBegin"),
      "hooks.events.value.0.common: ",
    ],
  ])("%s", (_name, change, message) => {
    expect(() => parseProviderProfile(draft(change), "draft.json")).toThrow(message);
    expect(() => parseProviderProfile(draft(change), "draft.json")).toThrow(
      "draft.json: invalid provider profile",
    );
  });
  it("text that is not JSON", () => {
    expect(() => parseProviderProfileText("{ nope", "draft.json")).toThrow(
      /draft\.json: invalid provider profile\n {2}not valid JSON: /,
    );
  });
  it.each([null, [], "profile"])("%j", (data) => {
    expect(() => parseProviderProfile(data)).toThrow("(profile): ");
  });
});
