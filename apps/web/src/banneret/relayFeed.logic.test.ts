import { describe, expect, it } from "vite-plus/test";

import {
  deepLinkTarget,
  needsCountLabel,
  needsKindLabel,
  safeLinkOut,
  stuckRulesLabel,
  workingStateLabel,
} from "./relayFeed.logic";

describe("relay feed words", () => {
  it("labels class-3 kinds and treats other and unknown kinds as generic items", () => {
    expect(needsKindLabel("agent_message")).toBe("Message from an agent");
    expect(needsKindLabel("persona_ask")).toBe("A persona asks");
    expect(needsKindLabel("other")).toBe("Item");
    expect(needsKindLabel("brand_new")).toBe("Item");
    expect(workingStateLabel("waiting")).toBe("waiting for you");
    expect(workingStateLabel("brand_new")).toBeNull();
  });

  it("lists every stuck reason in the relay's order", () => {
    expect(stuckRulesLabel(["check_failed", "unreviewed"])).toBe(
      "Checks are failing \u00b7 Ready but not reviewed",
    );
    expect(stuckRulesLabel(["claim_quiet"])).toBe("No activity on a claimed task");
    expect(stuckRulesLabel(["brand_new"])).toBe("Stuck");
  });

  it("renders only http(s) links out", () => {
    expect(safeLinkOut("https://github.com/example-org/app/pull/1")).toBe(
      "https://github.com/example-org/app/pull/1",
    );
    expect(safeLinkOut("javascript:alert(1)")).toBeNull();
    expect(safeLinkOut("data:text/html,x")).toBeNull();
    expect(safeLinkOut("not a url")).toBeNull();
    expect(safeLinkOut(undefined)).toBeNull();
  });

  it("counts from the relay first, then from what is loaded", () => {
    expect(needsCountLabel({ needsCount: 3, loaded: 50, more: true })).toBe("3");
    expect(needsCountLabel({ needsCount: 120, loaded: null, more: false })).toBe("99+");
    expect(needsCountLabel({ needsCount: null, loaded: 50, more: true })).toBe("50+");
    expect(needsCountLabel({ needsCount: null, loaded: 2, more: false })).toBe("2");
    expect(needsCountLabel({ needsCount: null, loaded: null, more: false })).toBeNull();
  });

  it("opens a known thread, else the link out, else names the machine", () => {
    const deepLink = { environmentId: "env-1", threadId: "th_1", machineLabel: "Bo desktop" };
    expect(
      deepLinkTarget({ deepLink, url: undefined, environmentKnown: true, threadKnown: true }),
    ).toEqual({ kind: "thread", environmentId: "env-1", threadId: "th_1" });
    expect(
      deepLinkTarget({
        deepLink,
        url: "https://github.com/x/y/issues/1",
        environmentKnown: true,
        threadKnown: false,
      }),
    ).toEqual({ kind: "link", url: "https://github.com/x/y/issues/1" });
    expect(
      deepLinkTarget({
        deepLink,
        url: "javascript:x",
        environmentKnown: false,
        threadKnown: false,
      }),
    ).toEqual({ kind: "elsewhere", machine: "Bo desktop" });
    expect(
      deepLinkTarget({
        deepLink: { environmentId: "env-2" },
        url: undefined,
        environmentKnown: false,
        threadKnown: false,
      }),
    ).toEqual({ kind: "elsewhere", machine: "another machine" });
    expect(
      deepLinkTarget({
        deepLink: undefined,
        url: undefined,
        environmentKnown: false,
        threadKnown: false,
      }),
    ).toEqual({ kind: "none" });
  });
});
