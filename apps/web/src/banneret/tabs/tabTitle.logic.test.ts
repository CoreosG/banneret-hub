import { describe, expect, it } from "vite-plus/test";

import { splitTabTitle } from "./tabTitle.logic";

/** The tail of each title when they are all open together; null keeps the plain end cut. */
const tails = (...titles: ReadonlyArray<string>) =>
  titles.map((title) => splitTabTitle(title, titles)?.tail ?? null);

describe("splitTabTitle", () => {
  it("keeps the numbered end of project names, with the word before it", () => {
    const service = "customer-billing-reconciliation-service-";
    expect(tails(`${service}0`, `${service}1`, `${service}8`)).toEqual([
      "service-0",
      "service-1",
      "service-8",
    ]);
  });

  it("starts the tail where chat titles part, not at their shared ending", () => {
    expect(
      tails(
        "Review the pull request for billing exports",
        "Review the pull request for account exports",
      ),
    ).toEqual(["billing exports", "account exports"]);
  });

  it("reaches back until two similar tabs no longer end alike", () => {
    const start = "shared-platform-prefix-";
    expect(
      tails(
        `${start}alpha-worker-x`,
        `${start}alpha-worker-y`,
        `${start}beta-worker-x`,
        `${start}beta-worker-y`,
      ),
    ).toEqual(["alpha-worker-x", "alpha-worker-y", "beta-worker-x", "beta-worker-y"]);
  });

  it("tells a name apart from a longer one that begins with it", () => {
    expect(
      tails("customer-billing-reconciliation", "customer-billing-reconciliation-worker"),
    ).toEqual(["reconciliation", "reconciliation-worker"]);
  });

  it("starts inside a very long word, just before the difference", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    expect(tails(`build/${hash}-linux`, `build/${hash}-macos`)).toEqual(["def-linux", "def-macos"]);
    expect(tails(`${hash}aaaaaaaaaaaa`, `${hash}bbbbbbbbbbbb`)).toEqual([
      "cdefaaaaaaaaaaaa",
      "cdefbbbbbbbbbbbb",
    ]);
  });

  it("leaves names whose difference an end cut already shows", () => {
    expect(tails("web", "api", "billing-api", "billing-web")).toEqual([null, null, null, null]);
    expect(tails("Plan the quarterly billing work")).toEqual([null]);
  });

  it("has nothing to tell apart between identical names", () => {
    expect(tails("A thread with a long shared name", "A thread with a long shared name")).toEqual([
      null,
      null,
    ]);
  });

  it("never changes the name", () => {
    const titles = ["abcdefgh-abcdefgh-one", "abcdefgh-abcdefgh-two", "abcdefgh-abcdefgh"];
    for (const title of titles) {
      const split = splitTabTitle(title, titles)!;
      expect(split.head + split.tail).toBe(title);
      expect(split.head.length).toBeGreaterThanOrEqual(8);
    }
  });
});
