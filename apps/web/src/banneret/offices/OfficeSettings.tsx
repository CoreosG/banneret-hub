import { useState } from "react";
import {
  OfficePresence,
  type OfficeSharing,
  type OfficeEdit,
  type BanneretTeam,
  officeMeetingUrlValid,
} from "@t3tools/contracts";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogHeader,
  DialogFooter,
  DialogPanel,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { enrolmentRpc, type RelayTarget } from "../enrolmentStore";
import type { EnterpriseFeed } from "../useEnterpriseFeed";

function useSave(target: RelayTarget) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(action: OfficeEdit) {
    setBusy(true);
    const result = await enrolmentRpc.officeEdit(target, action);
    setMessage(result.ok ? "Saved." : result.message);
    setBusy(false);
    return result.ok;
  }
  return { save, busy, message };
}

export function PresenceForm({
  person,
  enterprise,
}: {
  person: BanneretTeam["people"][number];
  enterprise: EnterpriseFeed;
}) {
  const flags = enterprise.feed.team?.value?.office?.flags ?? [];
  const [presence, setPresence] = useState(
    OfficePresence.literals.find((value) => value === person.presence) ?? "off",
  );
  const [status, setStatus] = useState(person.status?.text ?? "");
  const { busy, message, save } = useSave(enterprise.target);
  const [changed, setChanged] = useState({ presence: false, status: false });
  const bytes = new TextEncoder().encode(status).length;
  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void save({
          kind: "presence",
          ...(changed.presence && flags.includes("presence") && { presence }),
          ...(changed.status &&
            flags.includes("status") && { status: status ? { text: status } : null }),
        }).then((ok) => {
          if (ok) setChanged({ presence: false, status: false });
        });
      }}
    >
      {flags.includes("presence") && (
        <label>
          My presence{" "}
          <select
            disabled={busy}
            className="rounded-md border bg-background px-2 py-1"
            value={presence}
            onChange={(e) => {
              setPresence(e.target.value as typeof presence);
              setChanged({ ...changed, presence: true });
            }}
          >
            {OfficePresence.literals.map((p) => (
              <option key={p} value={p}>
                {p[0]?.toUpperCase()}
                {p.slice(1)}
              </option>
            ))}
          </select>
        </label>
      )}
      {flags.includes("status") && (
        <label>
          Status line{" "}
          <input
            className="rounded border px-2"
            value={status}
            disabled={busy}
            onChange={(e) => {
              setStatus(e.target.value);
              setChanged({ ...changed, status: true });
            }}
          />
        </label>
      )}
      {bytes > 80 && <p>Status must fit in 80 UTF-8 bytes.</p>}
      <Button
        type="submit"
        className="justify-self-start"
        disabled={busy || bytes > 80 || (!changed.presence && !changed.status)}
      >
        Save presence
      </Button>
      <span role="status">{message}</span>
    </form>
  );
}

export function SharingForm({ enterprise }: { enterprise: EnterpriseFeed }) {
  const [choice, choose] = useState<OfficeSharing>(
    enterprise.enrolment.sharing ?? {
      share: enterprise.feed.team?.value?.office?.preset === "community" ? "hidden" : "agents_only",
      shareUsage: false,
    },
  );
  const { busy, save, message } = useSave(enterprise.target);
  const label = enterprise.enrolment.label ?? "This machine";
  const named = choice.share === "agents_and_name";
  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4 text-sm">
      <h3 className="font-medium">Sharing settings</h3>
      <label>
        {enterprise.enrolment.me?.login} on {label}{" "}
        <select
          className="rounded-md border bg-background px-2 py-1"
          aria-label="Machine sharing"
          value={choice.share}
          onChange={(e) => choose({ ...choice, share: e.target.value as OfficeSharing["share"] })}
        >
          <option value="agents_and_name">Shared</option>
          <option value="agents_only">Agents only</option>
          <option value="hidden">Hidden</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          disabled={choice.share === "hidden"}
          checked={choice.shareUsage}
          onChange={(e) => choose({ ...choice, shareUsage: e.target.checked })}
        />{" "}
        Share stopped-agent reasons
      </label>
      <div aria-live="polite" className="rounded-md bg-muted p-3">
        <h4 className="font-medium">What others see</h4>
        <p>
          {named
            ? "Agents and machine name: " + label
            : choice.share === "agents_only"
              ? "Agents without the machine name"
              : "No agents or machine name"}
        </p>
        <p>
          Claims: {enterprise.enrolment.me?.login}/
          {named ? label.replace(/[^A-Za-z0-9._-]+/g, "-") : "private"}
        </p>
        {choice.shareUsage && choice.share !== "hidden" && <p>Stopped-agent reasons</p>}
      </div>
      <Button
        className="justify-self-start"
        disabled={busy}
        onClick={() => void save({ kind: "sharing", ...choice })}
      >
        Save sharing
      </Button>
      <span role="status">{message}</span>
    </section>
  );
}

export function MeetingEditor({
  target,
  board,
  url,
}: {
  target: RelayTarget;
  board: string | null;
  url?: string | undefined;
}) {
  const [editing, edit] = useState(false);
  const [link, setLink] = useState(url ?? "");
  const { save, busy, message } = useSave(target);
  const valid = !link || officeMeetingUrlValid(link);
  return (
    <div>
      {editing ? (
        <form
          className="grid gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save({ kind: "meeting", board, meetingUrl: link || null });
          }}
        >
          <label>
            Meeting URL{" "}
            <input
              className="rounded border px-2"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          {!valid && <p>Use an HTTPS URL without credentials, up to 300 bytes.</p>}
          <Button type="submit" disabled={busy || !valid}>
            Save link
          </Button>
          <button type="button" onClick={() => edit(false)}>
            Close
          </button>
          <span role="status">{message}</span>
        </form>
      ) : (
        <button
          type="button"
          className="text-xs underline"
          onClick={() => {
            setLink(url ?? "");
            edit(true);
          }}
        >
          Edit meeting link
        </button>
      )}
    </div>
  );
}

export function PresencePrompt({
  enterprise,
  person,
  open,
  close,
}: {
  enterprise: EnterpriseFeed;
  person: BanneretTeam["people"][number];
  open: boolean;
  close: () => void;
}) {
  const [reminder, setReminder] = useState(() =>
    enterprise.feed.team?.value?.office?.flags.includes("presence") &&
    (person.presence === "off" || person.presence === "away")
      ? person.presence
      : null,
  );
  const [changing, change] = useState(false);
  const showReminder =
    enterprise.feed.team?.value?.office?.preset === "company" &&
    !!reminder &&
    !open &&
    !changing &&
    person.presence === reminder;
  function dismiss() {
    setReminder(null);
    change(false);
    close();
  }
  return (
    <Dialog
      open={showReminder || open || changing}
      onOpenChange={(v) => {
        if (!v) dismiss();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {showReminder
              ? "You're shown as " + (reminder === "away" ? "Away" : "Off") + ". Change?"
              : "My presence"}
          </DialogTitle>
        </DialogHeader>
        {showReminder ? (
          <DialogFooter>
            <Button onClick={() => change(true)}>Change</Button>
            <Button variant="outline" onClick={dismiss}>
              Keep {reminder === "away" ? "Away" : "Off"}
            </Button>
          </DialogFooter>
        ) : (
          <DialogPanel>
            <PresenceForm enterprise={enterprise} person={person} />
          </DialogPanel>
        )}
      </DialogPopup>
    </Dialog>
  );
}
