import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { leaseRoute, machineAgent, routeProblem, type LeaseRouteInput } from "./leaseRoute.logic";

const DESK = EnvironmentId.make("desk");
const SERVER = EnvironmentId.make("server");
const RELAY = "https://relay.example.com";
const URL = "https://github.com/example-org/example-app/issues/2";

const joined = (origin: string, login: string, label: string) => ({
  state: "configured" as const,
  workspaceId: "ent-0123456789abcdef",
  relayOrigin: origin,
  displayName: "Example Company",
  label,
  me: {
    login,
    id: "p_me",
    permissions: [],
    role: { id: "staff", name: "Staff" },
    admission: "member" as const,
  },
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
    taskRef: { tracker: "github", key: "2", scope: "example-org/example-app", url: URL },
    heldOn: null,
    preferred: [],
  };
  const desk = {
    environmentId: DESK,
    label: "Desktop",
    issues: true,
    enrolments: [joined(RELAY, "ada", "desk"), joined("https://other.example", "ada", "desk")],
  };

  it("leaves out a machine another relay both share knows as someone else", () => {
    const server = {
      environmentId: SERVER,
      label: "dev-server",
      issues: true,
      enrolments: [joined("https://other.example", "bo", "dev-server")],
    };
    const route = leaseRoute({ ...base, environments: [desk, server] });
    expect(
      route.kind === "ready" && route.machines.map((machine) => machine.environmentId),
    ).toEqual([DESK]);
  });

  it("explains when the machine has not joined", () => {
    const route = leaseRoute({ ...base, environments: [{ ...desk, enrolments: [] }] });
    expect(routeProblem(route)).toContain("has not joined");
  });

  it("prefers the machine holding the claim, then the remembered one, then the page's own", () => {
    const server = {
      environmentId: SERVER,
      label: "dev-server",
      issues: true,
      enrolments: [joined(RELAY, "Ada", "dev-server")],
    };
    const environments = [desk, server];
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
