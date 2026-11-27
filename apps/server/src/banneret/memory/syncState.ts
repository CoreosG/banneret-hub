// @effect-diagnostics nodeBuiltinImport:off - these statements share the local note transaction.
import type * as NodeSqlite from "node:sqlite";

export const syncTables = `
create table if not exists repo_settings(singleton integer primary key check(singleton=1),url text,projects integer,status text);
create table if not exists repo_base(url text, folder text, key text, local text, remote text, primary key(url,folder,key));
create table if not exists repo_conflicts(key text primary key,alternative text);
create trigger if not exists clear_repo_conflict after delete on notes begin delete from repo_conflicts where key=old.key; end;
create trigger if not exists resolve_repo_conflict after update of confirmedAt on notes when new.confirmedAt is not null begin delete from repo_conflicts where key=new.key; end;`;

export function syncState(db: NodeSqlite.DatabaseSync) {
  return {
    setting() {
      const row = db.prepare("select * from repo_settings where singleton=1").get();
      return {
        url: String(row?.url ?? ""),
        projects: Boolean(row?.projects),
        status: String(row?.status ?? ""),
      };
    },
    configure(url: string, projects: boolean) {
      db.prepare("insert or replace into repo_settings values(1,?,?,'')").run(
        url,
        Number(projects),
      );
    },
    status(url: string, message: string) {
      db.prepare("update repo_settings set status=? where singleton=1 and url=?").run(message, url);
    },
    baseline(url: string, folder: string) {
      return new Map(
        db
          .prepare("select * from repo_base where url=? and folder=?")
          .all(url, folder)
          .map((r) => [String(r.key), { local: String(r.local), remote: String(r.remote) }]),
      );
    },
    remember(url: string, folder: string, key: string, local: string, remote: string) {
      db.prepare("insert or replace into repo_base values(?,?,?,?,?)").run(
        url,
        folder,
        key,
        local,
        remote,
      );
    },
    restore(key: string, meta: Record<string, unknown>) {
      const integer = (v: unknown) =>
        typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
      db.prepare(
        "update notes set createdAt=coalesce(?,createdAt), confirmedAt=?,lastUsedAt=?,useCount=?,pinned=?,disputedAt=?,disputeReason=? where key=?",
      ).run(
        integer(meta.created),
        integer(meta.confirmedAt),
        integer(meta.lastUsedAt),
        integer(meta.useCount) ?? 0,
        Number(meta.pinned === 1),
        integer(meta.disputedAt),
        typeof meta.disputeReason === "string" ? meta.disputeReason : null,
        key,
      );
    },
    conflict(key: string, alternative: string | null) {
      db.prepare("insert or replace into repo_conflicts values(?,?)").run(key, alternative);
    },
    pending(key: string) {
      return Boolean(db.prepare("select 1 from repo_conflicts where key=?").get(key));
    },
  };
}
