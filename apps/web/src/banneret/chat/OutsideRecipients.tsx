import type { ChatConversation } from "@t3tools/contracts";
import type { RelayTarget } from "../enrolmentStore";
import { members, useChatRead } from "./client";

export function OutsideRecipients({
  target,
  channels,
  personId,
  includeOutside,
}: {
  target: RelayTarget;
  channels: readonly ChatConversation[];
  personId: string;
  includeOutside: boolean;
}) {
  const list = useChatRead(async () => {
    const people = new Map<string, string>();
    for (const channel of channels) {
      if (channel.kind !== "channel" || channel.archived || !channel.me.member) continue;
      for (const person of await members(target, channel.id)) {
        if (person.id !== personId && (includeOutside || person.admission !== "outside"))
          people.set(person.id, person.login);
      }
    }
    return [...people].sort((a, b) => a[1].localeCompare(b[1]));
  }, 0);
  if (list.error) return <p role="alert">{list.error}</p>;
  if (!list.value) return <p role="status">Checking shared channels…</p>;
  if (!list.value.length) return <p>No eligible recipients in your channels.</p>;
  return (
    <>
      {list.value.map(([id, login]) => (
        <label key={id}>
          <input type="radio" name="recipient" value={id} /> {login}
        </label>
      ))}
    </>
  );
}
