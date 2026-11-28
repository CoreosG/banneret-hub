import { useState } from "react";
import type { MemoryReviewAction, MemoryContradiction } from "@t3tools/contracts";

export function MemoryContradictionCard({
  conflict,
  apply,
  writable,
}: {
  conflict: MemoryContradiction;
  writable: boolean;
  apply: (action: MemoryReviewAction) => Promise<void>;
}) {
  const { id, a, b } = conflict;
  const [mode, setMode] = useState<"choices" | "scope" | "edit">("choices");
  const [scopeA, setScopeA] = useState("running locally");
  const [scopeB, setScopeB] = useState("running in CI");
  const [draft, setDraft] = useState(a.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(action: MemoryReviewAction) {
    setBusy(true);
    try {
      await apply(action);
    } catch {
      setError("Could not resolve this contradiction. Review the latest notes and try again.");
    }
    setBusy(false);
  }
  return (
    <details className="chat-content-lane my-2 rounded border bg-muted p-3 text-sm">
      <summary className="cursor-pointer">
        <strong>Possible contradiction</strong>
        {[a, b].map((side, i) => (
          <span className="block" key={side.key ?? side.source}>
            {i ? "B" : "A"} · {side.key && "[" + side.key + "] "}
            {side.source}: {side.text.slice(0, 180)}
          </span>
        ))}
      </summary>
      {!b.key && <p>To change the provider rule, edit {b.source} yourself.</p>}
      {writable && (
        <fieldset disabled={busy} className="flex flex-wrap gap-3 py-2">
          {mode === "choices" ? (
            <>
              <button onClick={() => void save({ kind: "resolveConflict", id, choice: "keepA" })}>
                Keep A
              </button>
              <button onClick={() => void save({ kind: "resolveConflict", id, choice: "keepB" })}>
                Keep B
              </button>
              <button onClick={() => setMode("scope")}>Both apply in different scopes</button>
              <button onClick={() => setMode("edit")}>Edit</button>
            </>
          ) : mode === "scope" ? (
            <>
              <datalist id={"scope-" + id}>
                <option>running locally</option>
                <option>running in CI</option>
                <option>working on production</option>
              </datalist>
              <label>
                A applies when{" "}
                <input
                  list={"scope-" + id}
                  maxLength={128}
                  value={scopeA}
                  onChange={(e) => setScopeA(e.target.value)}
                />
              </label>
              <label>
                B applies when{" "}
                <input
                  list={"scope-" + id}
                  maxLength={128}
                  value={scopeB}
                  onChange={(e) => setScopeB(e.target.value)}
                />
              </label>
              <button
                disabled={
                  !scopeA.trim() ||
                  !scopeB.trim() ||
                  scopeA.trim().toLowerCase() === scopeB.trim().toLowerCase()
                }
                onClick={() => void save({ kind: "scopeConflict", id, scopeA, scopeB })}
              >
                Save scopes
              </button>
            </>
          ) : (
            <>
              <label>
                Edit Banneret note {a.key}
                <textarea
                  maxLength={4096}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              <button
                disabled={!draft.trim()}
                onClick={() => void save({ kind: "editConflict", id, text: draft.trim() })}
              >
                Save edit
              </button>
            </>
          )}
          {mode !== "choices" && <button onClick={() => setMode("choices")}>Cancel</button>}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
