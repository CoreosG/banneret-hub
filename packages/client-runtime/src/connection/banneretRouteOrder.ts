// Banneret Hub: a paired plain http route to another machine connects after the last https route.
// A copied environment kept a dead "Direct" http://<address>:3793 route ranked ahead of its working
// Tailscale HTTPS route, so every connect tried it first. Saved order (the settings list) is unchanged.
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Option from "effect/Option";

import type { ConnectionRoute } from "./catalog.ts";

function bearerUrl(route: ConnectionRoute): URL | null {
  if (route.target._tag !== "BearerConnectionTarget") return null;
  const profile = Option.getOrNull(route.profile);
  if (profile?._tag !== "BearerConnectionProfile") return null;
  try {
    return new URL(profile.httpBaseUrl);
  } catch {
    return null;
  }
}

const isHttps = (route: ConnectionRoute) => bearerUrl(route)?.protocol === "https:";

// Loopback always names this device and never crosses a network, so it keeps its place.
const isRemotePlainHttp = (route: ConnectionRoute) => {
  const url = bearerUrl(route);
  return url?.protocol === "http:" && !isLocalLoopbackHost(url.hostname);
};

/**
 * Moves plain http routes to another machine behind the last https route, keeping every other
 * route where it was. With no https route the order is unchanged. Every place that reads connect
 * order (the driver's attempts, the supervisor's better-route check) must use this same order, or a
 * demoted route reads as "better" and the supervisor keeps switching to it.
 */
export function preferHttpsRoutes(
  routes: ReadonlyArray<ConnectionRoute>,
): ReadonlyArray<ConnectionRoute> {
  const lastHttps = routes.findLastIndex(isHttps);
  if (lastHttps === -1) return routes;
  const demoted = routes.slice(0, lastHttps).filter(isRemotePlainHttp);
  if (demoted.length === 0) return routes;
  const kept = routes.filter((route) => !demoted.includes(route));
  const after = kept.indexOf(routes[lastHttps]!) + 1;
  return [...kept.slice(0, after), ...demoted, ...kept.slice(after)];
}
