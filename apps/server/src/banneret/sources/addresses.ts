// Banneret Hub: which addresses a company source, and a person's sign-in to it, may use.
// @effect-diagnostics nodeBuiltinImport:off - node:net classifies a source's literal IP address.
import * as NodeNet from "node:net";

// The relay-v1 source rules, checked again here: the Hub later sends a person's credential to this URL.
const privateNetworks = new NodeNet.BlockList();
privateNetworks.addSubnet("10.0.0.0", 8);
privateNetworks.addSubnet("172.16.0.0", 12);
privateNetworks.addSubnet("192.168.0.0", 16);
privateNetworks.addSubnet("100.64.0.0", 10);
privateNetworks.addSubnet("fc00::", 7, "ipv6");

export function sourceUrlAllowed(value: string): boolean {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.endsWith(".ts.net")) return true;
  const family = NodeNet.isIP(host);
  return family !== 0 && privateNetworks.check(host, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Whether a person's token may be sent to `target` for a source at `sourceUrl`: HTTPS, or plain HTTP
 * on the source's own address or a private network. Never the company relay's own address.
 */
export function mayCarrySignIn(target: string, relayOrigin: string, sourceUrl: string) {
  const to = URL.parse(target);
  if (!to || to.username || to.password || to.origin === URL.parse(relayOrigin)?.origin)
    return false;
  if (to.protocol === "https:") return true;
  return (
    to.protocol === "http:" &&
    (to.origin === URL.parse(sourceUrl)?.origin || sourceUrlAllowed(to.origin))
  );
}
