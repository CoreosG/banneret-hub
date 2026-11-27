import { syncCopy, type CopyContext, verifyRepo } from "./gitCopy.ts";
import { withNotes } from "./store.ts";

const work = new Map<string, Promise<unknown>>();
const timers = new Map<string, AbortController>();
function serialize<T>(file: string, run: () => Promise<T>) {
  const next = (work.get(file) ?? Promise.resolve()).catch(() => {}).then(run);
  work.set(file, next);
  return next.finally(() => {
    if (work.get(file) === next) work.delete(file);
  });
}

export function repoCommands(ctx: CopyContext & { delay: (signal: AbortSignal) => Promise<void> }) {
  const open = <T>(f: Parameters<typeof withNotes<T>>[3]) =>
    withNotes(ctx.file, ctx.project, ctx.now(), f);
  const sync = () =>
    serialize(ctx.file, async () => {
      const { url } = open((s) => s.repo.setting());
      let status: string;
      try {
        status = await syncCopy(ctx);
      } catch (e) {
        status = e instanceof Error ? e.message : "Git copy failed.";
      }
      open((s) => s.repo.status(url, status));
      return status;
    });
  const schedule = () => {
    if (!open((s) => s.repo.setting().url)) return;
    const key = JSON.stringify([ctx.file, ctx.project]);
    timers.get(key)?.abort();
    const timer = new AbortController();
    timers.set(key, timer);
    void ctx
      .delay(timer.signal)
      .then(() => {
        if (timers.get(key) !== timer) return;
        timers.delete(key);
        return sync();
      })
      .catch(() => {});
  };
  return {
    sync,
    schedule,
    configure: (url: string, projects: boolean) =>
      serialize(ctx.file, async () => {
        if (url) {
          if (!(await ctx.allowed())) throw new Error("Git copy is disabled for this workspace.");
          await verifyRepo(url);
        }
        open((s) => s.repo.configure(url, projects));
        schedule();
      }),
  };
}
