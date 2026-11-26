#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node CLI for manual runs of the fake relay.
import * as NodeUtil from "node:util";

import { startFakeRelay } from "./fake.ts";

// node packages/banneret-relay-fake/src/bin.ts --port 0 [--manual-approval] [--network-identity-header <name>] [--public-origin <url>]
const { values } = NodeUtil.parseArgs({
  options: {
    port: { type: "string", default: "0" },
    host: { type: "string", default: "127.0.0.1" },
    "manual-approval": { type: "boolean", default: false },
    "network-identity-header": { type: "string" },
    "public-origin": { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});

const relay = await startFakeRelay({
  port: Number(values.port),
  host: values.host,
  autoApprove: !values["manual-approval"],
  ...(values["network-identity-header"] === undefined
    ? {}
    : { networkIdentityHeader: values["network-identity-header"] }),
  ...(values["public-origin"] === undefined ? {} : { publicOrigin: values["public-origin"] }),
  ...(values.quiet ? {} : { log: (line: string) => console.error(line) }),
});

console.log(relay.url);
const stop = () => {
  void relay.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
