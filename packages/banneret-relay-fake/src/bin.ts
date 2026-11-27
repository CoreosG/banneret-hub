#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node CLI for manual runs of the fake relay.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { startFakeRelay, type FakeRelayOptions } from "./fake.ts";

// node packages/banneret-relay-fake/src/bin.ts --port 0 [--manual-approval] [--network-identity-header <name>] [--public-origin <url>]
const { values } = NodeUtil.parseArgs({
  options: {
    port: { type: "string", default: "0" },
    host: { type: "string", default: "127.0.0.1" },
    "manual-approval": { type: "boolean", default: false },
    "network-identity-header": { type: "string" },
    "public-origin": { type: "string" },
    config: { type: "string" },
    chat: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

const settings: Pick<
  FakeRelayOptions,
  "pool" | "healthSources" | "dashboards" | "board" | "criticalRecipients" | "alarmDatabase"
> = values.config === undefined ? {} : JSON.parse(NodeFS.readFileSync(values.config, "utf8"));
const relay = await startFakeRelay({
  ...(settings.pool && { pool: settings.pool }),
  ...(settings.healthSources && { healthSources: settings.healthSources }),
  ...(settings.dashboards && { dashboards: settings.dashboards }),
  ...(settings.board && { board: settings.board }),
  ...(settings.criticalRecipients && { criticalRecipients: settings.criticalRecipients }),
  ...(settings.alarmDatabase && { alarmDatabase: settings.alarmDatabase }),
  chat: values.chat,
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
