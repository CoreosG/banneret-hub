// @effect-diagnostics nodeBuiltinImport:off - uses the caller's private SQLite transaction.
import type * as NodeSqlite from "node:sqlite";

const week = 7 * 86400000;
export const workflowTables = `
create table if not exists workflow_schedule(thread text primary key, due integer not null);
create table if not exists workflow_reports(thread text primary key, created integer not null,
 retries integer not null, proposed integer not null, contested integer not null, stale integer not null,
 fired integer not null, acknowledged integer not null, pending integer not null, failures integer not null, waiting integer not null, disputed integer not null, corrections integer not null, topRule text, topCount integer not null, proposalKey text);`;

// Persisted in the private store. Disabled -> enable -> due in a week. Due -> report + next week
// in the same transaction. Disable removes the deadline. Restart resumes the stored deadline.
// A weekly report needs review until acknowledged. Manual runs preserve an outstanding notice.
export function workflowStore(db: NodeSqlite.DatabaseSync, thread: string, now: number) {
  const schedule = () => db.prepare("select due from workflow_schedule where thread=?").get(thread);
  const current = () => {
    const r = db.prepare("select * from workflow_reports where thread=?").get(thread);
    return r
      ? {
          topRule: r.topRule ? String(r.topRule) : null,
          topCount: Number(r.topCount),
          proposalKey: r.proposalKey ? String(r.proposalKey) : null,
          failures: Number(r.failures),
          waiting: Number(r.waiting),
          disputed: Number(r.disputed),
          corrections: Number(r.corrections),
          created: Number(r.created),
          retries: Number(r.retries),
          proposed: Number(r.proposed),
          contested: Number(r.contested),
          stale: Number(r.stale),
          fired: Number(r.fired),
          acknowledged: Number(r.acknowledged),
          pending: !!r.pending,
        }
      : null;
  };
  return {
    current,
    weekly: () => !!schedule(),
    due: () => Number(schedule()?.due) <= now,
    schedule(enabled: boolean) {
      if (enabled)
        db.prepare("insert or ignore into workflow_schedule values(?,?)").run(thread, now + week);
      else db.prepare("delete from workflow_schedule where thread=?").run(thread);
    },
    dismiss(created: number) {
      db.prepare("update workflow_reports set pending=0 where thread=? and created=?").run(
        thread,
        created,
      );
    },
    run(
      s: {
        list(
          pending: boolean,
          main: boolean,
        ): readonly { key: string; trust: string; why: string }[];
        reminders(thread: string): {
          status(): { fired: number; acknowledged: number; contested: number };
        };
      },
      retries: number,
      scheduled: boolean,
      failures = 0,
      waiting = 0,
    ): ReturnType<typeof current> {
      if (scheduled && !(Number(schedule()?.due) <= now)) return null;
      const notes = s.list(false, true);
      const { fired, acknowledged, contested } = s.reminders(thread).status();
      const mostFrequent = db
        .prepare(
          "select key,count(*) as n from reminders where thread=? group by key order by n desc,key limit 1",
        )
        .get(thread);
      const proposed = notes.filter((n) => n.trust === "proposed");
      db.prepare(
        "insert or replace into workflow_reports values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        thread,
        now,
        retries,
        proposed.length,
        contested,
        notes.filter((n) => n.trust === "stale").length,
        fired,
        acknowledged,
        Number(scheduled || current()?.pending || false),
        failures,
        waiting,
        notes.filter((n) => n.trust === "disputed").length,
        notes.filter((n) => n.why === "You repeated this correction.").length,
        mostFrequent?.key ?? null,
        mostFrequent?.n ?? 0,
        proposed[0]?.key ?? null,
      );
      if (scheduled)
        db.prepare("update workflow_schedule set due=? where thread=?").run(now + week, thread);
      return current();
    },
  };
}
