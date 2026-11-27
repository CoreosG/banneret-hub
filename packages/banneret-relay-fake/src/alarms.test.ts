// @effect-diagnostics nodeBuiltinImport:off - exercise the relay's database across a real close and reopen.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { openAlarmStore, type Alarm } from "./alarms.ts";

it("keeps replay receipts and resolved occurrences after reopening", () => {
  using directory = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "relay-alarms-"));
  const file = NodePath.join(directory.path, "alarms.sqlite");
  const alarm: Alarm = {
    id: "outage",
    sourceId: "service",
    title: "Service down",
    severity: "critical",
    firedAt: "2026-11-27T00:00:00Z",
  };
  const first = openAlarmStore(file);
  try {
    expect(first.record(alarm, "signature1", 300000, 0)).toBe(true);
  } finally {
    first.close();
  }
  const reopened = openAlarmStore(file);
  try {
    expect(reopened.active()).toEqual([alarm]);
    expect(reopened.record(alarm, "signature1", 300000, 1)).toBe(false);
    reopened.record({ ...alarm, resolvedAt: "2026-11-27T00:02:00Z" }, "signature2", 301000, 1000);
    reopened.record(alarm, "signature3", 302000, 2000);
    expect(reopened.active()).toEqual([]);
    const recurrence = { ...alarm, firedAt: "2026-11-27T00:03:00Z" };
    reopened.record(recurrence, "signature4", 303000, 3000);
    expect(reopened.active()).toEqual([recurrence]);
  } finally {
    reopened.close();
  }
});
