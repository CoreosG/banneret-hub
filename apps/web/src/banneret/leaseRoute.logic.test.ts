import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { leaseRoute, machineAgent, ownIssueRef, type LeaseRouteInput } from "./leaseRoute.logic";

const DESK = EnvironmentId.make("desk");
const SERVER = EnvironmentId.make("server");
const RELAY = "https://relay.example.com";
const URL = "https://github.com/example-org/example-app/issues/2";

const projectOn = (environmentId: EnvironmentId, repo: string) =>
  ({
    id: ProjectId.make(`${environmentId}-${repo}`),
    workspaceRoot: `/workspace/${repo}`,
    environmentId,
    repositoryIdentity: {
      provider: "github",
      displayName: `example-org/${repo}`,
      canonicalKey: `github.com/example-org/${repo}`,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://github.com/example-org/${repo}.git`,
      },
    },
  }) as unknown as EnvironmentProject;

const joined = (origin: string, login: string, label: string) => ({
  state: "configured" as const,
  workspaceId: "ent-0123456789abcdef",
  relayOrigin: origin,
  displayName: "Example Company",
  label,
  me: { login, role: "staff" },
});

describe("ownIssueRef", () => {
  it("resolves only through a project on the issue's own repository", () => {
    expect(ownIssueRef(URL, [projectOn(DESK, "example-app")])?.scope).toBe(
      "example-org/example-app",
    );
    // A project on another repository of the same host only lends its login for reading.
    expect(ownIssueRef(URL, [projectOn(DESK, "other-app")])).toBeNull();
  });
});

describe("machineAgent", () => {
  it("fits the machine label into the claim's agent slot", () => {
    expect(machineAgent("Ada laptop")).toBe("Ada-laptop");
    expect(machineAgent("dev.server_1")).toBe("dev.server_1");
    expect(machineAgent("  ")).toBe("hub");
    expect(machineAgent("x".repeat(80))).toHaveLength(64);
  });
});

describe("leaseRoute", () => {
  const base: Omit<LeaseRouteInput, "environments"> = {
    page: { environmentId: DESK, relayOrigin: RELAY },
    taskUrl: URL,
    repo: "example-org/example-app",
    pageRef: null,
    heldOn: null,
    preferred: [],
  };
  const desk = {
    environmentId: DESK,
    label: "Desktop",
    issues: true,
    projects: [projectOn(DESK, "other-app")],
    enrolments: [joined(RELAY, "ada", "desk"), joined("https://other.example", "ada", "desk")],
  };

  it("leaves out a machine another relay both share knows as someone else", () => {
    const server = {
      environmentId: SERVER,
      label: "dev-server",
      issues: true,
      projects: [projectOn(SERVER, "example-app")],
      enrolments: [joined("https://other.example", "bo", "dev-server")],
    };
    expect(leaseRoute({ ...base, environments: [desk, server] }).kind).toBe("none");
    const mine = { ...server, enrolments: [joined("https://other.example", "ada", "dev-server")] };
    expect(leaseRoute({ ...base, environments: [desk, mine] })).toEqual({
      kind: "not-joined",
      machine: "dev-server",
      company: "Example Company",
    });
  });

  it("prefers the machine holding the claim, then the remembered one, then the page's own", () => {
    const deskWithRepo = { ...desk, projects: [projectOn(DESK, "example-app")] };
    const server = {
      environmentId: SERVER,
      label: "dev-server",
      issues: true,
      projects: [projectOn(SERVER, "example-app")],
      enrolments: [joined(RELAY, "Ada", "dev-server")],
    };
    const environments = [deskWithRepo, server];
    const chosen = (extra: Partial<LeaseRouteInput>) => {
      const route = leaseRoute({ ...base, ...extra, environments });
      return route.kind === "ready" ? route.chosen.environmentId : null;
    };
    expect(chosen({})).toBe(DESK);
    expect(chosen({ preferred: [SERVER] })).toBe(SERVER);
    expect(chosen({ preferred: [SERVER], heldOn: DESK })).toBe(DESK);
    // A remembered machine that no longer qualifies is skipped.
    expect(chosen({ preferred: [EnvironmentId.make("gone")] })).toBe(DESK);
  });
});
