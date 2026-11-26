// Banneret Hub: the Task tab's relay read and the Task dialog. The server reads `GET /tasks/{taskId}`
// for the preview and the sign-off; the header draws from the board card when the board holds the
// task. With no thread or draft open to hold a right panel, the Task tab opens in a dialog instead.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  BANNERET_RELAY_FEED_WS_METHODS,
  type BanneretTaskRead,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { TaskSurface } from "./taskSurface";

const taskCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:task",
  tag: BANNERET_RELAY_FEED_WS_METHODS.task,
});

/** Every call the Task tab makes; tests replace it. Null when the call itself failed. */
export const taskRpc = {
  read: async (environmentId: EnvironmentId, taskId: string): Promise<BanneretTaskRead | null> => {
    try {
      const result = await runAtomCommand(appAtomRegistry, taskCommand, {
        environmentId,
        input: { taskId },
      });
      return result._tag === "Success" ? result.value : null;
    } catch {
      return null;
    }
  },
};

export type TaskReadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "done"; readonly read: BanneretTaskRead | null };

/**
 * The relay's task read while `enabled`: on open, and again when `revision` moves (a new board file,
 * so the preview or the sign-off may have changed). A reread keeps showing the last answer.
 */
export function useTaskRead(
  environmentId: EnvironmentId,
  taskId: string,
  enabled: boolean,
  revision: string | null,
): TaskReadState {
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly revision: string | null;
    readonly read: BanneretTaskRead | null;
  } | null>(null);
  const key = `${environmentId}\u0000${taskId}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the relay when the tab opens and when the board changes
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void taskRpc.read(environmentId, taskId).then((read) => {
      if (current) setAnswer({ key: `${environmentId}\u0000${taskId}`, revision, read });
    });
    return () => {
      current = false;
    };
  }, [environmentId, taskId, enabled, revision]);
  if (!enabled) return { kind: "idle" };
  return answer?.key === key ? { kind: "done", read: answer.read } : { kind: "loading" };
}

interface TaskDialogState {
  readonly surface: TaskSurface | null;
}

/** The task shown in the Task dialog; null when the dialog is closed. */
export const useTaskDialogStore = create<TaskDialogState>(() => ({ surface: null }));

export function openTaskDialog(surface: TaskSurface | null): void {
  useTaskDialogStore.setState({ surface });
}
