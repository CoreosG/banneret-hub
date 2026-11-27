// Banneret Hub: the Task tab's right-panel surface. It carries the whole relay task, so the tab can
// always show its title and link out, even before (or without) any relay read.
import type { BanneretBoardTask } from "@t3tools/contracts";

/** What a saved Task tab keeps of its task: enough to title it and link out. Dates come from the relay. */
export type TaskIdentity = Pick<BanneretBoardTask, "id" | "title" | "ref">;

export interface TaskSurface {
  readonly id: `task:${string}`;
  readonly kind: "task";
  /** The environment that joined the relay and reads the task. */
  readonly environmentId: string;
  readonly task: TaskIdentity;
}

export function taskSurface(environmentId: string, task: TaskIdentity): TaskSurface {
  return {
    id: `task:${encodeURIComponent(environmentId)}:${encodeURIComponent(task.id)}`,
    kind: "task",
    environmentId,
    task: {
      id: task.id,
      title: task.title,
      ref: {
        tracker: task.ref.tracker,
        ...(task.ref.host === undefined ? {} : { host: task.ref.host }),
        scope: task.ref.scope,
        key: task.ref.key,
        url: task.ref.url,
      },
    },
  };
}

const isText = (value: unknown): value is string => typeof value === "string";
const isName = (value: unknown): value is string => isText(value) && value.trim() !== "";

/**
 * The surface rebuilt from a saved copy, or null when it is not a task surface. Saved panels pass
 * registered kinds through unchecked, so the panel checks before it reads.
 */
export function decodeTaskSurface(surface: unknown): TaskSurface | null {
  if (typeof surface !== "object" || surface === null) return null;
  const { environmentId, task } = surface as Record<string, unknown>;
  if (!isName(environmentId) || typeof task !== "object" || task === null) return null;
  const { id, title, ref } = task as Record<string, unknown>;
  if (!isName(id) || !isText(title) || typeof ref !== "object" || ref === null) return null;
  const { tracker, host, scope, key, url } = ref as Record<string, unknown>;
  if (!isText(tracker) || !isText(scope) || !isText(key) || !isText(url)) return null;
  if (host !== undefined && !isText(host)) return null;
  return taskSurface(environmentId, {
    id,
    title,
    ref: { tracker, scope, key, url, ...(host === undefined ? {} : { host }) },
  });
}

/** The tab's title: the task's own, or "Task" for a saved copy that is not one. */
export function taskTabTitle(surface: unknown): string {
  return decodeTaskSurface(surface)?.task.title || "Task";
}
