import { useId, useState } from "react";
import type { ChatConversation } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import type { RelayTarget } from "../enrolmentStore";
import { chatRpc } from "./client";

type Channel = Extract<ChatConversation, { kind: "channel" }>;

/**
 * Archive or unarchive one channel. The patch carries `archived` alone: a founder who sees only the
 * directory entry of a private channel may archive it, but may not change anything else.
 */
export function ArchiveChannel({
  target,
  channel,
  done,
}: {
  target: RelayTarget;
  channel: Channel;
  done: () => void;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "saving">("idle");
  const [error, setError] = useState("");
  const reason = useId();
  if (!channel.me.can.manage) return null;
  // The relay refuses to archive a default channel.
  if (channel.defaultChannel)
    return (
      <div className="grid justify-items-start gap-2 wrap-anywhere">
        <Button type="button" variant="destructive-outline" disabled aria-describedby={reason}>
          Archive channel
        </Button>
        <p id={reason} className="text-xs text-muted-foreground">
          This is a default channel. People in your company are added to it automatically, so it
          cannot be archived.
        </p>
      </div>
    );
  async function apply(archived: boolean) {
    setStep("saving");
    setError("");
    try {
      await chatRpc.run(target, { kind: "settings", id: channel.id, patch: { archived } });
      setStep("idle");
      done();
    } catch (e) {
      setStep("idle");
      setError(String(e));
    }
  }
  return (
    <div className="grid justify-items-start gap-2 wrap-anywhere">
      {channel.archived ? (
        <Button
          type="button"
          variant="outline"
          disabled={step === "saving"}
          onClick={() => void apply(false)}
        >
          Unarchive channel
        </Button>
      ) : step === "idle" ? (
        <Button type="button" variant="destructive-outline" onClick={() => setStep("confirm")}>
          Archive channel
        </Button>
      ) : (
        <div role="group" aria-label={`Archive #${channel.name}`} className="grid gap-2">
          <p>
            Archive #{channel.name}? Nobody can post or join until it is unarchived. Nothing is
            deleted.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={step === "saving"}
              onClick={() => void apply(true)}
            >
              Confirm archive
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={step === "saving"}
              onClick={() => setStep("idle")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
