// @effect-diagnostics nodeBuiltinImport:off - hashing and SQLite writes are synchronous within one decision.
import * as NodeCrypto from "node:crypto";
import type * as NodeSqlite from "node:sqlite";

export interface HeldCall {
  threadId: string;
  threadTitle: string;
  destination: string;
  sensitive: boolean;
  turn: string;
  source: string;
  name: string;
  args: string;
  context: string;
  allowAlways: boolean;
}
export type Choice = "once" | "always" | "refuse";
export interface Approval extends HeldCall {
  id: string;
  created: number;
  state: "pending" | "running" | "ran" | "failed" | "unknown" | "refused" | "expired";
  actor: string;
  reason: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}

// Open once per machine process. Pending rows retain the transport context needed to run;
// an interrupted running row has no safe retry, whether the remote write returned or not.
export function approvalStore(db: NodeSqlite.DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY, threadId TEXT NOT NULL, turn TEXT NOT NULL, source TEXT NOT NULL,
    threadTitle TEXT NOT NULL,destination TEXT NOT NULL,sensitive INTEGER NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, context TEXT NOT NULL, hash TEXT NOT NULL,
    allowAlways INTEGER NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS repeats ON calls(threadId,source,name,hash,state);
    CREATE TABLE IF NOT EXISTS rules(threadId TEXT,source TEXT,name TEXT,destination TEXT,actor TEXT, PRIMARY KEY(threadId,source,name,destination));
    UPDATE calls SET state='unknown' WHERE state='running'`);
  function expireOld() {
    db.prepare(
      "UPDATE calls SET state='expired' WHERE state='pending' AND created<=(unixepoch('subsec')-86400)*1000",
    ).run();
  }
  function unpack(row: Record<string, unknown>) {
    return {
      ...row,
      sensitive: !!row.sensitive,
      allowAlways: !!row.allowAlways,
    } as unknown as Approval;
  }
  function get(id: string) {
    expireOld();
    const row = db.prepare("SELECT * FROM calls WHERE id=?").get(id);
    if (!row) throw new Error("Call approval not found.");
    return unpack(row);
  }
  return {
    get,
    list(thread?: string) {
      expireOld();
      return (
        thread
          ? db.prepare("SELECT * FROM calls WHERE threadId=? ORDER BY created").all(thread)
          : db.prepare("SELECT * FROM calls WHERE state='pending' ORDER BY created").all()
      ).map(unpack);
    },
    hold(call: HeldCall) {
      const { threadId, turn, source, name, args, context, allowAlways } = call;
      const hash = NodeCrypto.createHash("sha256")
        .update(canonical(JSON.parse(args)))
        .digest("hex");
      const refused = db
        .prepare(
          "SELECT * FROM calls WHERE threadId=? AND source=? AND name=? AND hash=? AND destination=? AND state='refused' LIMIT 1",
        )
        .get(threadId, source, name, hash, call.destination);
      if (refused) return unpack(refused);
      const rule =
        allowAlways &&
        db
          .prepare(
            "SELECT actor FROM rules WHERE threadId=? AND source=? AND name=? AND destination=?",
          )
          .get(threadId, source, name, call.destination);
      const id = NodeCrypto.randomUUID();
      db.prepare(
        "INSERT INTO calls (id,threadId,threadTitle,destination,sensitive,turn,source,name,args,context,hash,allowAlways,created,state,actor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,unixepoch('subsec')*1000,?,?)",
      ).run(
        id,
        threadId,
        call.threadTitle,
        call.destination,
        Number(call.sensitive),
        turn,
        source,
        name,
        args,
        context,
        hash,
        Number(allowAlways),
        rule ? "running" : "pending",
        rule ? rule.actor! : "",
      );
      return get(id);
    },
    decide(id: string, choice: Choice, actor: string, reason: string) {
      let won = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const call = get(id);
        if (call.state === "pending") {
          won = true;
          if (choice === "always" && !call.allowAlways)
            throw new Error("This call needs approval each time.");
          if (choice === "refuse" && !reason.trim()) throw new Error("Give the agent a reason.");
          db.prepare("UPDATE calls SET state=?, actor=?, reason=? WHERE id=?").run(
            choice === "refuse" ? "refused" : "running",
            actor,
            choice === "refuse" ? reason : "",
            id,
          );
          if (choice === "always")
            db.prepare("INSERT OR REPLACE INTO rules VALUES(?,?,?,?,?)").run(
              call.threadId,
              call.source,
              call.name,
              call.destination,
              actor,
            );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { call: get(id), won };
    },
    finish(id: string, state: "ran" | "failed", reason = "") {
      db.prepare("UPDATE calls SET state=?,reason=? WHERE id=? AND state='running'").run(
        state,
        reason,
        id,
      );
    },
    expire(id: string) {
      db.prepare("UPDATE calls SET state='expired' WHERE id=? AND state='pending'").run(id);
    },
  };
}
