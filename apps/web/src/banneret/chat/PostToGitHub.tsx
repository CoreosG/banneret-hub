import { useState } from "react";
import { allBoardCards } from "@t3tools/contracts";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { chatRpc } from "./client";

// The picker lives in the message menu. Only submit writes. Remount starts idle.
type State =
  | { kind: "idle" | "choosing" | "posting" }
  | { kind: "failed"; message: string }
  | { kind: "posted"; url: string };
export function PostToGitHub({
  enterprise,
  id,
  linked,
}: {
  enterprise: EnterpriseFeed;
  id: string;
  linked: string | undefined;
}) {
  const [state, set] = useState<State>({ kind: "idle" });
  if (state.kind === "idle")
    return <button onClick={() => set({ kind: "choosing" })}>Post to GitHub</button>;
  if (state.kind === "posted")
    return (
      <a href={state.url} target="_blank" rel="noreferrer">
        Posted to {new URL(state.url).pathname}
      </a>
    );
  const tasks = allBoardCards(enterprise.feed.board?.value)
    .map((c) => c.task)
    .filter((t) => t.ref.tracker === "github");
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (state.kind === "posting") return;
        const taskId = new FormData(e.currentTarget).get("task");
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return;
        set({ kind: "posting" });
        try {
          const url = await chatRpc.run(enterprise.target, {
            kind: "promote",
            id,
            scope: task.ref.scope,
            key: task.ref.key,
            host: task.ref.host ?? "github.com",
            hubOrigin: location.origin,
          });
          set(
            typeof url === "string" && url.startsWith("https://")
              ? { kind: "posted", url }
              : { kind: "failed", message: "Check the issue for your comment." },
          );
        } catch (error) {
          set({ kind: "failed", message: String(error) });
        }
      }}
    >
      {tasks.length === 0 && <span>No GitHub issues on the board.</span>}
      <label>
        GitHub issue{" "}
        <select
          required
          name="task"
          defaultValue={linked ?? ""}
          disabled={state.kind === "posting"}
        >
          <option value="">Choose an issue</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.ref.scope}#{t.ref.key} · {t.title}
            </option>
          ))}
        </select>
      </label>
      <button disabled={!tasks.length || state.kind === "posting"}>
        {state.kind === "posting" ? "Posting..." : "Post comment"}
      </button>
      <button
        type="button"
        disabled={state.kind === "posting"}
        onClick={() => set({ kind: "idle" })}
      >
        Cancel
      </button>
      {state.kind === "failed" && <span role="alert">{state.message}</span>}
    </form>
  );
}
