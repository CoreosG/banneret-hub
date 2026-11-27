// @effect-diagnostics nodeBuiltinImport:off - the reference relay owns its SQLite database.
import * as NodeSqlite from "node:sqlite";

export interface Alarm {
  id: string;
  sourceId: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail?: string;
  url?: string;
  firedAt: string;
  resolvedAt?: string;
}

export function openAlarmStore(path: string) {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alarms (
      source TEXT, id TEXT, fired REAL, resolved INTEGER, payload TEXT, PRIMARY KEY(source,id)
    );
    CREATE TABLE IF NOT EXISTS hook_receipts (
      source TEXT, signature TEXT, expires INTEGER, PRIMARY KEY(source, signature)
    );
  `);
  const active = db.prepare(`
    WITH eligible AS (
      SELECT *, CASE json_extract(payload, '$.severity')
        WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END AS priority
      FROM alarms WHERE resolved = 0 AND source IN (SELECT value FROM json_each(?))
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY source ORDER BY priority DESC, fired DESC, id) AS position
      FROM eligible
    )
    SELECT payload FROM ranked WHERE position <= 20 ORDER BY priority DESC, fired DESC, source, id LIMIT 100
  `);
  const save = db.prepare(`
    INSERT INTO alarms VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source,id) DO UPDATE SET fired=excluded.fired, resolved=excluded.resolved, payload=excluded.payload
    WHERE excluded.fired > alarms.fired OR (excluded.fired = alarms.fired AND alarms.resolved = 0)
  `);
  const receipt = db.prepare("INSERT OR IGNORE INTO hook_receipts VALUES (?, ?, ?)");
  const prune = db.prepare("DELETE FROM hook_receipts WHERE expires < ?");
  return {
    active: (sources: readonly string[]) =>
      active.all(JSON.stringify(sources)).map((row) => JSON.parse(String(row.payload)) as Alarm),
    record(alarm: Alarm, signature: string, expires: number, now: number) {
      db.exec("BEGIN IMMEDIATE");
      try {
        prune.run(now);
        const fresh = receipt.run(alarm.sourceId, signature, expires).changes !== 0;
        if (fresh)
          save.run(
            alarm.sourceId,
            alarm.id,
            Date.parse(alarm.firedAt),
            Number(alarm.resolvedAt !== undefined),
            JSON.stringify(alarm),
          );
        db.exec("COMMIT");
        return fresh;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
