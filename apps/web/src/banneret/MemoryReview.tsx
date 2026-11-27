import type { MemoryReviewAction, MemoryReviewNote } from "@t3tools/contracts";
import { useState } from "react";
import { Section } from "./ui/Section";

type Apply = (action: MemoryReviewAction) => Promise<void>;
function MemoryReview({
  note,
  apply,
  writable,
}: {
  note: MemoryReviewNote;
  apply: Apply;
  writable: boolean;
}) {
  const [mode, setMode] = useState<"edit" | "flag" | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const proposed = note.trust === "proposed";
  const disputed = note.trust === "disputed";
  async function save(action: MemoryReviewAction) {
    setBusy(true);
    try {
      await apply(action);
      setMode(null);
      setError("");
    } catch {
      setError("Could not save. Review the latest note and try again.");
    }
    setBusy(false);
  }
  function button(label: string, action: () => void) {
    return (
      <button type="button" className="rounded border px-2 py-1 hover:bg-accent" onClick={action}>
        {label}
      </button>
    );
  }
  return (
    <article className="grid gap-1.5 break-words border-b px-3 py-2 text-sm">
      <strong>{note.key}</strong>
      <p className="whitespace-pre-wrap">{note.text}</p>
      {proposed && (
        <p className="text-xs text-muted-foreground">
          Source: <span className="whitespace-pre-line">{note.source}</span>
          <br />
          Why: {note.why || "No reason supplied."}
        </p>
      )}
      {note.alternative && (
        <p className="whitespace-pre-wrap">Repository text: {note.alternative}</p>
      )}
      {disputed && (
        <p>
          Flagged by {note.flaggedBy || "Unknown"}: {note.reason}. Treated as unconfirmed until you
          resolve it.
        </p>
      )}
      {writable && (
        <fieldset disabled={busy} className="flex flex-wrap items-center gap-1.5 text-xs">
          {mode ? (
            <>
              <textarea
                aria-label={mode === "flag" ? "Reason" : "Note text"}
                className="w-full rounded border p-2"
                maxLength={mode === "flag" ? 512 : 4096}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                disabled={!draft.trim()}
                onClick={() =>
                  void save(
                    mode === "flag"
                      ? { kind: "flag", reason: draft.trim() }
                      : {
                          kind: proposed ? "editConfirm" : disputed ? "editKeep" : "edit",
                          text: draft.trim(),
                        },
                  )
                }
              >
                {mode === "flag"
                  ? "Submit flag"
                  : proposed
                    ? "Save and confirm"
                    : disputed
                      ? "Save and keep"
                      : "Save"}
              </button>
              {button("Cancel", () => setMode(null))}
            </>
          ) : (
            <>
              {proposed &&
                button(
                  note.alternative ? "Keep this machine’s text" : "Confirm",
                  () => void save({ kind: "confirm" }),
                )}
              {note.alternative &&
                button(
                  "Use repository text",
                  () => void save({ kind: "editConfirm", text: note.alternative! }),
                )}
              {disputed && button("Keep", () => void save({ kind: "keep" }))}
              {button(proposed ? "Edit then confirm" : "Edit", () => {
                setDraft(note.text);
                setMode("edit");
              })}
              {!proposed && !disputed && (
                <>
                  {button(
                    note.trust === "pinned" ? "Unpin" : "Pin",
                    () => void save({ kind: note.trust === "pinned" ? "unpin" : "pin" }),
                  )}
                  {button("Flag", () => {
                    setDraft("");
                    setMode("flag");
                  })}
                  {(note.trust === "stale" || note.trust === "archived") &&
                    button("Keep it", () => void save({ kind: "refresh" }))}
                </>
              )}
              {button(
                proposed ? "Dismiss" : "Remove",
                () => void save({ kind: proposed ? "dismiss" : "remove" }),
              )}
            </>
          )}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

export function MemoryNotes({
  notes,
  confirmBatch,
  expanded,
  writable,
  apply,
}: {
  notes: readonly MemoryReviewNote[];
  expanded: boolean;
  confirmBatch?: (batch: string, notes: readonly MemoryReviewNote[]) => Promise<void>;
  writable: boolean;
  apply: (note: MemoryReviewNote, action: MemoryReviewAction) => Promise<void>;
}) {
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [batchError, setBatchError] = useState("");
  const row = (note: MemoryReviewNote) => (
    <MemoryReview
      key={note.key + ":" + note.version}
      note={note}
      writable={writable}
      apply={(action) => apply(note, action)}
    />
  );
  return (
    <div className="max-h-[35dvh] overflow-y-auto overscroll-contain">
      {expanded && (
        <div className="grid gap-2 p-2">
          <div className="flex gap-3 text-xs">
            <label>
              Kind{" "}
              <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All kinds</option>
                {["user", "feedback", "project", "reference"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              Scope{" "}
              <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">All scopes</option>
                {["personal", "project"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          </div>
          {writable &&
            confirmBatch &&
            [
              ...new Set(
                notes.flatMap((n) => (n.trust === "proposed" && n.batch ? [n.batch] : [])),
              ),
            ].map((batch) => {
              const pending = notes.filter((n) => n.trust === "proposed" && n.batch === batch);
              return (
                <button
                  key={batch}
                  disabled={confirming}
                  onClick={async () => {
                    setConfirming(true);
                    setBatchError("");
                    try {
                      await confirmBatch(batch, pending);
                    } catch {
                      setBatchError("Confirmation interrupted. Review remaining proposals.");
                    }
                    setConfirming(false);
                  }}
                >
                  Confirm {pending.length} imported notes from batch {batch?.slice(0, 8)}
                </button>
              );
            })}
          {batchError && <p role="alert">{batchError}</p>}
          {!notes.length && <p>No matching notes.</p>}
          {["proposed", "disputed", "pinned", "trusted", "confirmed", "stale", "archived"].map(
            (trust) => {
              const group = notes.filter(
                (n) =>
                  n.trust === trust && (!kind || n.kind === kind) && (!scope || n.scope === scope),
              );
              return (
                group.length > 0 && (
                  <Section
                    key={trust}
                    title={trust[0]!.toUpperCase() + trust.slice(1)}
                    count={group.length}
                  >
                    {group.map(row)}
                  </Section>
                )
              );
            },
          )}
        </div>
      )}
      {!expanded &&
        notes
          .filter((n) => n.trust === "proposed" || n.trust === "disputed")
          .map((n) => (
            <Section
              key={n.key}
              title={n.trust === "proposed" ? "Proposed note · unconfirmed" : "Disputed note"}
              attention
            >
              {row(n)}
            </Section>
          ))}
    </div>
  );
}
