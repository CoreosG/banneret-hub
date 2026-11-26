import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { preferHttpsRoutes } from "./banneretRouteOrder.ts";
import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { connectOverRoutes } from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { connectionRouteId, entryWithRoutes, usableRoutes } from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const LOOPBACK = direct("loopback", "http://127.0.0.1:3793/");
const LAN = direct("lan", "http://192.168.1.10:3793/");
const TAILNET_IP = direct("tailnet-ip", "http://100.101.102.103:3793/");
const PUBLIC_HTTP = direct("public-http", "http://203.0.113.7:3793/");
const TAILSCALE_HTTPS = direct("tailscale-https", "https://desk.tail1234.ts.net/");
const PUBLIC_HTTPS = direct("public-https", "https://desk.example.com/");
const RELAY: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Desk" }),
  profile: Option.none(),
};
const SSH: ConnectionRoute = {
  target: new SshConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Desk",
    connectionId: "ssh",
  }),
  profile: Option.none(),
};

const ids = (routes: ReadonlyArray<ConnectionRoute>) =>
  routes.map((route) => connectionRouteId(route.target));

describe("preferHttpsRoutes", () => {
  it("moves a plain http route to another machine behind the https route", () => {
    expect(ids(preferHttpsRoutes([LAN, TAILSCALE_HTTPS, RELAY]))).toEqual([
      "tailscale-https",
      "lan",
      "relay",
    ]);
    expect(ids(preferHttpsRoutes([TAILNET_IP, PUBLIC_HTTP, PUBLIC_HTTPS]))).toEqual([
      "public-https",
      "tailnet-ip",
      "public-http",
    ]);
  });

  it("keeps loopback first, and relay and SSH where they were", () => {
    expect(
      ids(preferHttpsRoutes([LOOPBACK, LAN, SSH, TAILSCALE_HTTPS, PUBLIC_HTTPS, RELAY])),
    ).toEqual(["loopback", "ssh", "tailscale-https", "public-https", "lan", "relay"]);
  });

  it("leaves the order alone without an https route, or with http already behind it", () => {
    const plain = [LAN, PUBLIC_HTTP, RELAY];
    expect(preferHttpsRoutes(plain)).toBe(plain);
    const sorted = [TAILSCALE_HTTPS, LAN, RELAY];
    expect(preferHttpsRoutes(sorted)).toBe(sorted);
  });
});

describe("connect order", () => {
  const entry = (routes: ReadonlyArray<ConnectionRoute>): ConnectionCatalogEntry =>
    entryWithRoutes({ target: LAN.target, profile: LAN.profile, enabled: true }, routes);

  it("connects over https before a saved http route that is ahead of it", () => {
    const saved = entry([TAILNET_IP, TAILSCALE_HTTPS]);
    expect(ids(usableRoutes(saved))).toEqual(["tailscale-https", "tailnet-ip"]);
  });

  it.effect("tries the https route first, and never reaches the dead http one", () =>
    Effect.gen(function* () {
      const attempted: Array<string> = [];
      const lease = yield* connectOverRoutes(
        entry([TAILNET_IP, TAILSCALE_HTTPS]),
        () => Effect.succeed("answered" as const),
        (route) => {
          attempted.push(connectionRouteId(route.target));
          return route === TAILSCALE_HTTPS
            ? Effect.succeed({ prepared: { target: route.target }, session: {} } as never)
            : Effect.fail(new ConnectionTransientError({ reason: "transport", detail: "dead" }));
        },
      ).pipe(Effect.scoped);
      expect(attempted).toEqual(["tailscale-https"]);
      expect(lease.refusedRouteIds).toEqual([]);
    }),
  );
});
