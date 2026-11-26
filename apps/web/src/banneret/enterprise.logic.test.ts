import type { BanneretEnrolmentView, BanneretWorkspace } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canForget,
  cleanLogin,
  connectedLine,
  loginOrUnknown,
  loginSuffix,
  canJoinAgain,
  countdown,
  enrolmentLine,
  forgetNotice,
  isKnownSectionKind,
  isValidMachineLabel,
  lastResultMessage,
  letterAvatar,
  machineLabelFrom,
  needsItemLabel,
  remoteUrlsOf,
  revokedMessage,
  roleLabel,
  wizardStep,
} from "./enterprise.logic";

const workspace: BanneretWorkspace = {
  id: "ent-0123456789abcdef",
  name: "Example Company",
  kind: "enterprise",
  projectKeys: [],
  relay: { origin: "https://relay.example.com", displayName: "Example Company" },
  updatedAt: "2026-11-26T10:00:00.000Z",
};

const joined = (overrides: Partial<BanneretEnrolmentView> = {}): BanneretEnrolmentView => ({
  state: "configured",
  workspaceId: workspace.id,
  relayOrigin: "https://relay.example.com",
  displayName: "Example Company",
  machineId: "m_1",
  label: "Ada laptop",
  me: { login: "ada-example", role: "founder" },
  ...overrides,
});

describe("wizardStep", () => {
  it.each([
    [null, "address"],
    [{ state: "none" }, "address"],
    [{ state: "requested" }, "code"],
    [{ state: "awaiting_approval" }, "awaiting"],
    [{ state: "approved" }, "finishing"],
    [{ state: "configured", health: "healthy" }, "connected"],
    [{ state: "configured", health: "unreachable" }, "connected"],
    [{ state: "configured", health: "refused" }, "address"],
    [{ state: "revoked" }, "revoked"],
  ] as const)("maps %j to %s", (view, step) => {
    expect(wizardStep(view)).toBe(step);
  });
});

describe("lastResultMessage", () => {
  it.each([
    ["cancelled", "Joining was cancelled."],
    ["declined", "A founder declined this machine."],
    ["not_staff", "That account is not on the company's staff list."],
    ["network_identity_mismatch", "The sign-in did not come from your registered network."],
    [
      "environment_enrolled",
      "Another person has already joined this machine. They must remove it first.",
    ],
    ["code_expired", "The code expired before it was confirmed. Join again."],
    ["too_many_attempts", "Too many wrong codes were typed. Join again."],
    ["approval_expired", "No founder approved this machine within 7 days. Join again."],
    ["not_found", "The relay no longer knows this request. Join again."],
    ["token_lost", "Approved, but this Hub lost the token. Join again."],
    ["key_lost", "This Hub lost its machine key. Join again."],
    ["left", "You left the company. This machine is no longer joined."],
    ["forgotten", "This machine was forgotten here. A founder must still remove it on the relay."],
  ])("says why for %s", (reason, message) => {
    expect(lastResultMessage({ state: "none", reason })).toBe(message);
  });

  it("falls back to the relay's words, then a generic line, for an unknown reason", () => {
    expect(lastResultMessage({ state: "none", reason: "refused", message: "Nope." })).toBe("Nope.");
    expect(lastResultMessage({ state: "none", reason: "something_new" })).toBe(
      "Joining did not finish. Try again.",
    );
  });

  it("says nothing without a last result or outside none", () => {
    expect(lastResultMessage(null)).toBeNull();
    expect(lastResultMessage({ state: "none" })).toBeNull();
    expect(lastResultMessage({ state: "requested", reason: "declined" })).toBeNull();
  });
});

describe("revokedMessage", () => {
  it("names the company, or says the machine was replaced", () => {
    expect(
      revokedMessage({ state: "revoked", displayName: "Example Company", reason: "removed" }),
    ).toBe("This machine was removed from Example Company");
    expect(
      revokedMessage({ state: "revoked", displayName: "Example Company", reason: "replaced" }),
    ).toBe("This machine was replaced by a newer enrolment");
  });
});

describe("enrolmentLine", () => {
  it("says a workspace from another machine is not joined here", () => {
    expect(enrolmentLine(workspace, null)).toEqual({
      tone: "muted",
      text: "Not joined on this machine · Join",
    });
    expect(enrolmentLine(workspace, { state: "none" })).toEqual({
      tone: "muted",
      text: "Not joined on this machine · Join",
    });
    expect(enrolmentLine(workspace, joined({ workspaceId: "ent-ffffffffffffffff" })).text).toBe(
      "Not joined on this machine · Join",
    );
  });

  it.each([
    [{ state: "requested" }, "warn", "Waiting for sign-in"],
    [{ state: "awaiting_approval" }, "warn", "Waiting for a founder to approve"],
    [{ state: "approved" }, "muted", "Finishing setup…"],
    [{ health: "healthy" }, "ok", "Connected as ada-example"],
    [{ health: "healthy", me: { login: " ", role: "founder" } }, "ok", "Connected"],
    [{ health: "unreachable" }, "warn", "Cannot reach relay.example.com"],
    [{ health: "clock_wrong" }, "warn", "This machine's clock is wrong"],
    [{ health: "refused" }, "error", "The relay refused this machine"],
    [{ health: "forbidden" }, "error", "The relay does not allow this machine"],
    [{ health: "invalid_reply" }, "error", "The relay's answers do not match this version"],
    [{}, "muted", "Checking the connection…"],
    [{ state: "approved", health: "unreachable" }, "warn", "Cannot reach relay.example.com"],
    [
      { state: "approved", health: "invalid_reply" },
      "error",
      "The relay's answers do not match this version",
    ],
    [
      { state: "revoked", reason: "removed" },
      "error",
      "This machine was removed from Example Company",
    ],
    [
      { state: "revoked", reason: "replaced" },
      "error",
      "This machine was replaced by a newer enrolment",
    ],
  ] as const)("shows %j as %s: %s", (overrides, tone, text) => {
    expect(enrolmentLine(workspace, joined(overrides))).toEqual({ tone, text });
  });

  it("says since when the relay is unreachable", () => {
    const line = enrolmentLine(
      workspace,
      joined({ health: "unreachable", unreachableSince: "2026-11-26T10:00:00.000Z" }),
    );
    expect(line.text).toMatch(/^Cannot reach relay\.example\.com since /);
  });
});

describe("helpers", () => {
  it("offers forget only while the relay cannot confirm", () => {
    expect(canForget(joined({ health: "healthy" }))).toBe(false);
    expect(canForget(joined())).toBe(false);
    expect(canForget(joined({ health: "unreachable" }))).toBe(true);
    expect(canForget(joined({ health: "refused" }))).toBe(true);
    expect(canForget({ state: "revoked" })).toBe(false);
    expect(canForget(joined({ state: "approved" }))).toBe(false);
    expect(canForget(joined({ state: "approved", health: "forbidden" }))).toBe(true);
  });

  it("offers Join again only after a 401 refusal", () => {
    expect(canJoinAgain(joined({ health: "refused" }))).toBe(true);
    expect(canJoinAgain(joined({ health: "forbidden" }))).toBe(false);
    expect(canJoinAgain(joined({ state: "approved", health: "refused" }))).toBe(false);
    expect(canJoinAgain(null)).toBe(false);
  });

  it.each([
    ["unreachable", "The relay cannot be reached."],
    ["refused", "The relay refused this machine, so it cannot confirm that it left."],
    ["forbidden", "The relay does not allow this machine to remove itself."],
    ["clock_wrong", "This machine's clock is wrong, so the relay would reject its calls."],
    ["invalid_reply", "The relay's answers do not match this version of Banneret Hub."],
  ] as const)("explains forgetting while %s", (health, opening) => {
    const notice = forgetNotice(joined({ health }));
    expect(notice?.startsWith(opening)).toBe(true);
    expect(notice).toContain("a founder must then remove it on the relay");
  });

  it("says nothing about forgetting while healthy", () => {
    expect(forgetNotice(joined({ health: "healthy" }))).toBeNull();
    expect(forgetNotice(joined())).toBeNull();
  });

  it("counts down minutes and seconds, stopping at zero", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    expect(countdown("2026-11-26T10:09:41Z", now)).toBe("9:41");
    expect(countdown("2026-11-26T09:59:00Z", now)).toBe("0:00");
    expect(countdown(undefined, now)).toBe("");
  });

  it("treats unknown roles as limited staff", () => {
    expect(roleLabel("founder")).toBe("Founder");
    expect(roleLabel("limited_staff")).toBe("Staff");
    expect(roleLabel("auditor")).toBe("Staff");
  });

  it("shows unknown needs kinds as a generic row and skips unknown sections", () => {
    expect(needsItemLabel("mention")).toEqual({ label: "Mention", generic: false });
    expect(needsItemLabel("brand_new_kind")).toEqual({ label: "Item", generic: true });
    expect(isKnownSectionKind("today")).toBe(true);
    expect(isKnownSectionKind("brand_new_section")).toBe(false);
  });

  it("draws a letter avatar instead of fetching an icon", () => {
    expect(letterAvatar("example company")).toBe("E");
    expect(letterAvatar("  <img src=x>")).toBe("I");
    expect(letterAvatar("")).toBe("?");
  });

  it("makes machine labels the relay accepts", () => {
    expect(machineLabelFrom("Ada's MacBook Pro")).toBe("Ada s MacBook Pro");
    expect(machineLabelFrom("—")).toBe("My machine");
    expect(isValidMachineLabel("Ada laptop")).toBe(true);
    expect(isValidMachineLabel("<img src=x onerror=alert(1)>")).toBe(false);
  });

  it("collects git remotes, never folders", () => {
    expect(
      remoteUrlsOf([
        { repositoryIdentity: null },
        {
          repositoryIdentity: {
            canonicalKey: "github.com/example-org/app",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:example-org/app.git",
            },
          },
        },
        {
          repositoryIdentity: {
            canonicalKey: "github.com/example-org/app",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:example-org/app.git",
            },
          },
        },
      ]),
    ).toEqual(["git@github.com:example-org/app.git"]);
  });
});

describe("login copy", () => {
  it("names the person and role", () => {
    expect(connectedLine({ login: "ada-example", role: "founder" })).toBe(
      "Connected as ada-example \u00b7 Founder",
    );
  });

  it("drops an empty or whitespace login but keeps the role", () => {
    expect(connectedLine({ login: "", role: "founder" })).toBe("Connected \u00b7 Founder");
    expect(connectedLine({ login: "  \t", role: "staff" })).toBe("Connected \u00b7 Staff");
  });

  it("drops a missing role", () => {
    expect(connectedLine({ login: "ada-example", role: "" })).toBe("Connected as ada-example");
    expect(connectedLine({ login: "", role: "" })).toBe("Connected");
    expect(connectedLine(undefined)).toBe("Connected");
  });

  it("never leaves a dangling separator for other people", () => {
    expect(cleanLogin("  ada ")).toBe("ada");
    expect(cleanLogin("   ")).toBe("");
    expect(loginOrUnknown("")).toBe("Unknown");
    expect(loginOrUnknown("ada")).toBe("ada");
    expect(loginSuffix("from", "ada")).toBe(" \u00b7 from ada");
    expect(loginSuffix("from", " ")).toBe("");
    expect(loginSuffix("claimed by", undefined)).toBe("");
  });
});
