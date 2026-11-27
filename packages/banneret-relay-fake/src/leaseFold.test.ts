// @effect-diagnostics nodeBuiltinImport:off - reads the shared fixtures from the canonical spec folder.
import * as NodeFS from "node:fs";

import {
  foldLease,
  formatReleaseComment,
  checkReleaseComment,
  parseLeaseLine,
  type LeaseFoldInput,
  type LeaseFoldResult,
} from "@t3tools/contracts/leaseProtocol";
import { describe, expect, it } from "vite-plus/test";

import { specDirectory } from "./spec.ts";

// The shared lease fold fixtures (README, "Lease protocol"). The Go relay runs the same files.
const fixtureDirectory = `${specDirectory}fixtures/lease-fold/`;
const fixtures = NodeFS.readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith(".json"))
  .toSorted();

interface Fixture {
  readonly name: string;
  readonly description: string;
  readonly input: LeaseFoldInput;
  readonly expected: LeaseFoldResult;
}

describe("lease fold fixtures", () => {
  it("has the cases the protocol names", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtures)("%s", (file) => {
    const fixture = JSON.parse(
      NodeFS.readFileSync(`${fixtureDirectory}${file}`, "utf8"),
    ) as Fixture;
    expect(fixture.name).toBe(file.replace(/\.json$/, ""));
    expect(fixture.description.length).toBeGreaterThan(0);
    expect(foldLease(fixture.input)).toEqual(fixture.expected);
  });

  it("does not depend on the order comments arrive in", () => {
    for (const file of fixtures) {
      const fixture = JSON.parse(
        NodeFS.readFileSync(`${fixtureDirectory}${file}`, "utf8"),
      ) as Fixture;
      const reversed = { ...fixture.input, comments: fixture.input.comments.toReversed() };
      expect(foldLease(reversed), file).toEqual(fixture.expected);
    }
  });
});

describe("lease comment lines", () => {
  it("writes a release that reads back the same", () => {
    const input = {
      reason: "other" as const,
      reasonText: "not needed after the redesign",
      freeToContinue: true,
      note: "**Next:** close it.",
      followUps: ["#51", "#52"],
    };
    expect(checkReleaseComment(input)).toBeNull();
    const body = formatReleaseComment(input);
    expect(body).toBe(
      "release: other · not needed after the redesign · free to continue\n**Next:** close it.\nFollow-ups: #51, #52",
    );
    expect(parseLeaseLine(body)).toEqual({
      kind: "release",
      reason: "other",
      freeToContinue: true,
      reasonText: "not needed after the redesign",
      note: "**Next:** close it.\nFollow-ups: #51, #52",
    });
  });

  it("refuses what it could not read back", () => {
    expect(checkReleaseComment({ reason: "other", freeToContinue: false })).not.toBeNull();
    expect(
      checkReleaseComment({ reason: "done", reasonText: "a\nb", freeToContinue: false }),
    ).not.toBeNull();
    expect(
      checkReleaseComment({ reason: "done", note: "é".repeat(1_100), freeToContinue: false }),
    ).not.toBeNull();
    expect(
      checkReleaseComment({ reason: "lost_claim" as never, freeToContinue: false }),
    ).not.toBeNull();
  });

  it("reads the system reasons as withdrawals and ignores other comments", () => {
    expect(parseLeaseLine("release: lost_claim · @ada-example")).toEqual({
      kind: "withdraw",
      reason: "lost_claim",
    });
    expect(parseLeaseLine("Thanks!")).toBeNull();
    expect(parseLeaseLine("claim:")).toBeNull();
    expect(parseLeaseLine("claim: ada-example/hub")).toEqual({
      kind: "claim",
      login: "ada-example",
      agent: "hub",
    });
  });
});
