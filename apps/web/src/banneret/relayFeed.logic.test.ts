import { describe, expect, it } from "vite-plus/test";

import {
  deepLinkTarget,
  needsCountLabel,
  needsKindLabel,
  safeLinkOut,
  shippedRefLabel,
  shippedLabel,
  taskRefLabel,
  stuckSubject,
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

  it("says merged first for every shipped state", () => {
    expect(shippedLabel("live")).toBe("merged, live");
    expect(shippedLabel("deploy_failed")).toBe("merged, deploy failed");
    expect(shippedLabel("brand_new")).toBe("merged");
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

describe("shipped and stuck subjects", () => {
  it("names a shipped item by its own pull request: the repository name and number", () => {
    expect(shippedRefLabel({ number: 38, repo: "example-org/example-app" })).toBe(
      "example-app \u00b7 #38",
    );
    expect(shippedRefLabel({ number: 7, repo: "group/sub/app" })).toBe("app \u00b7 #7");
    expect(shippedRefLabel({ number: 9, repo: " " })).toBe("#9");
  });

  it("uses the task title, then its number and repository, else says nothing is named", () => {
    expect(stuckSubject({ title: "Profile blocks" })).toEqual({
      kind: "task",
      title: "Profile blocks",
      url: undefined,
    });
    const url = "https://github.com/example-org/example-app/issues/12";
    expect(stuckSubject({ title: "", url })).toEqual({
      kind: "task",
      title: "#12 in example-app",
      url,
    });
    expect(stuckSubject({ title: "" })).toEqual({ kind: "none" });
    expect(stuckSubject(undefined)).toEqual({ kind: "none" });
  });

  it("names a task-less item by its subject: repo and run name, linked to the run", () => {
    const run = {
      name: "ci / test",
      url: "https://github.com/example-org/example-app/actions/runs/9",
    };
    expect(stuckSubject(undefined, { repo: "example-org/example-app", run })).toEqual({
      kind: "task",
      title: "example-org/example-app \u00b7 ci / test",
      url: run.url,
    });
    expect(stuckSubject(undefined, { repo: "example-org/example-app" })).toEqual({
      kind: "task",
      title: "example-org/example-app",
      url: undefined,
    });
    const jobUrl = "https://jobs.example.com/nightly-backup";
    expect(stuckSubject(undefined, { job: { name: "nightly-backup", url: jobUrl } })).toEqual({
      kind: "task",
      title: "nightly-backup",
      url: jobUrl,
    });
    expect(
      stuckSubject(undefined, { repo: "example-org/ops", job: { name: "nightly-backup" } }),
    ).toEqual({ kind: "task", title: "example-org/ops \u00b7 nightly-backup", url: undefined });
    expect(taskRefLabel("https://github.com/example-org/example-app/issues/12")).toBe(
      "example-app#12",
    );
    expect(taskRefLabel("javascript:alert(1)")).toBeNull();
    expect(stuckSubject(undefined, { job: { name: "nightly-backup" } })).toEqual({
      kind: "task",
      title: "nightly-backup",
      url: undefined,
    });
    expect(stuckSubject({ title: "Profile blocks" }, { repo: "example-org/example-app" })).toEqual({
      kind: "task",
      title: "Profile blocks",
      url: undefined,
    });
  });
});
