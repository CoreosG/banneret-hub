import { expect, test } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - exercise SQLite across closing and reopening a real file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { approvalStore } from "./approvalStore.ts";

const call = {
  threadId: "thread",
  threadTitle: "Builder",
  destination: "tracker",
  sensitive: false,
  turn: "turn",
  source: "banneret",
  name: "post",
  args: '{"text":"original"}',
  context: "{}",
  allowAlways: true,
};
test("decisions bind the stored call, and exact refused repeats get the original reason", () => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  const store = approvalStore(db);
  const first = store.hold(call);
  store.decide(first.id, "refuse", "Ana", "Wrong recipient");
  expect(store.hold({ ...call, args: '{ "text": "original" }' })).toMatchObject({
    id: first.id,
    reason: "Wrong recipient",
  });
  const changed = store.hold({ ...call, args: '{"text":"new"}' });
  expect(changed.state).toBe("pending");
  expect(store.decide(changed.id, "once", "Leo", "").call.args).toBe('{"text":"new"}');
  expect(store.decide(changed.id, "refuse", "Ana", "Stop").call.actor).toBe("Leo");
  const recovered = approvalStore(db);
  expect(recovered.get(changed.id).state).toBe("unknown");
});
test("pending survives restart and a destructive call cannot create or use an always rule", () => {
  using dir = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "call-approvals-"));
  const file = NodePath.join(dir.path, "calls.sqlite");
  const db = new NodeSqlite.DatabaseSync(file);
  const store = approvalStore(db);
  const first = store.hold(call);
  store.decide(first.id, "always", "Ana", "");
  expect(store.hold({ ...call, args: "{}" }).state).toBe("running");
  const sensitive = store.hold({ ...call, sensitive: true, allowAlways: false });
  db.close();
  using reopened = new NodeSqlite.DatabaseSync(file);
  const recovered = approvalStore(reopened);
  expect(recovered.get(first.id).state).toBe("unknown");
  expect(recovered.get(sensitive.id).state).toBe("pending");
  expect(() => recovered.decide(sensitive.id, "always", "Ana", "")).toThrow();
});
