import { useState } from "react";
import type { ChatConversation, ChatMember, ChannelTemplate } from "@t3tools/contracts";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Button } from "../../components/ui/button";
import type { EnterpriseFeed } from "../useEnterpriseFeed";
import { ArchiveChannel } from "./ArchiveChannel";
import { chatRpc } from "./client";

type Channel = Extract<ChatConversation, { kind: "channel" }>;
type Template = typeof ChannelTemplate.Type;
const templateNames = {
  general: "General",
  team: "Team",
  private: "Private",
  announcement: "Announcement",
  shared: "Shared with outsiders",
  community: "Community",
} satisfies Record<Template, string>;
export const templates = Object.entries(templateNames) as [Template, string][];
export function templateSettings(template: Template): {
  access: Channel["access"];
  agents: Channel["agents"];
} {
  const hidden = template === "private" || template === "shared";
  const shared = template === "shared" || template === "community";
  const announcement = template === "announcement";
  return {
    access: {
      visibility: hidden ? "private" : "public",
      join: hidden ? "invite" : template === "community" ? "request" : "open",
      outsiders: template === "shared" ? "invited" : template === "community" ? "listed" : "none",
      post: announcement ? "managers" : "everyone",
      replies: "everyone",
      invite: shared || announcement ? "managers" : "members",
    },
    agents: shared ? "mentions_only" : announcement ? "off" : "allowed",
  };
}
function Choice<T extends string>({
  label,
  value,
  options,
  change,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  change: (v: T) => void;
}) {
  return (
    <label className="grid gap-1">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => {
          const match = options.find(([id]) => id === e.target.value);
          if (match) change(match[0]);
        }}
      >
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ChannelSettings({
  enterprise,
  channel,
  people,
  close,
  saved,
}: {
  enterprise: EnterpriseFeed;
  channel: Channel;
  people: readonly Extract<ChatMember, { kind: "person" }>[] | undefined;
  close: () => void;
  saved: () => void;
}) {
  const [access, setAccess] = useState(channel.access),
    [agents, setAgents] = useState(channel.agents),
    [managers, setManagers] = useState(channel.managers);
  const [roleIds, setRoleIds] = useState(channel.access.postRoles?.join(", ") ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const outside =
    channel.me.can.openToOutside &&
    enterprise.enrolment.me?.permissions.includes("channels.openToOutside");
  const closing = access.outsiders === "none" && channel.access.outsiders !== "none";
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>#{channel.name} settings</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Managed by{" "}
            {channel.managers.map((m) => m.login).join(", ") || "workspace administrators"}
          </p>
        </SheetHeader>
        <form
          className="overflow-auto px-6 pb-6 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!channel.me.can.manage || busy) return;
            const { postRoles: _old, ...fields } = access;
            setBusy(true);
            try {
              await chatRpc.run(enterprise.target, {
                kind: "settings",
                id: channel.id,
                patch: {
                  access: {
                    ...fields,
                    ...(access.post === "roles"
                      ? {
                          postRoles: roleIds
                            .split(",")
                            .map((id) => id.trim())
                            .filter(Boolean),
                        }
                      : {}),
                  },
                  agents,
                  managers,
                },
              });
              saved();
              close();
            } catch (e) {
              setError(String(e));
            }
            setBusy(false);
          }}
        >
          <fieldset disabled={!channel.me.can.manage || busy} className="grid gap-4">
            <fieldset>
              <legend>Start from</legend>
              <div className="grid grid-cols-2 gap-2">
                {templates
                  .filter(([id]) => {
                    const preset = templateSettings(id);
                    return (
                      (outside || preset.access.outsiders === access.outsiders) &&
                      (!channel.defaultChannel || preset.access.visibility === "public")
                    );
                  })
                  .map(([id, name]) => (
                    <Button
                      type="button"
                      key={id}
                      variant="outline"
                      onClick={() => {
                        const preset = templateSettings(id);
                        setAgents(preset.agents);
                        setAccess(preset.access);
                      }}
                    >
                      {name}
                    </Button>
                  ))}
              </div>
            </fieldset>
            <Choice
              label="Who can find it"
              value={access.visibility}
              options={
                channel.defaultChannel || (!outside && access.outsiders === "listed")
                  ? [["public", "Public"]]
                  : [
                      ["public", "Public"],
                      ["private", "Only members (hidden)"],
                    ]
              }
              change={(visibility) =>
                setAccess({
                  ...access,
                  visibility,
                  ...(visibility === "private"
                    ? {
                        join: "invite",
                        outsiders: access.outsiders === "listed" ? "invited" : access.outsiders,
                      }
                    : {}),
                })
              }
            />
            <Choice
              label="Who can join"
              value={access.join}
              options={
                access.visibility === "private"
                  ? [["invite", "Invite only"]]
                  : [
                      ["open", "Open"],
                      ["request", "Ask to join"],
                      ["invite", "Invite only"],
                    ]
              }
              change={(join) => setAccess({ ...access, join })}
            />
            {outside ? (
              <Choice
                label="Outside collaborators"
                value={access.outsiders}
                options={[
                  ["none", "None"],
                  ["invited", "Named people"],
                  ...(access.visibility === "public"
                    ? [["listed", "Can find and join"] as const]
                    : []),
                ]}
                change={(outsiders) => setAccess({ ...access, outsiders })}
              />
            ) : (
              <p>Outside collaborators: {access.outsiders}. Ask a founder to change this.</p>
            )}
            <Choice
              label="Who can post"
              value={access.post}
              options={[
                ["everyone", "All members"],
                ["roles", "Selected roles"],
                ["managers", "Managers only"],
              ]}
              change={(post) => setAccess({ ...access, post })}
            />
            {access.post === "roles" && (
              <label>
                Posting role IDs
                <input
                  required
                  value={roleIds}
                  onChange={(e) => setRoleIds(e.target.value)}
                  placeholder="founder, staff"
                />
              </label>
            )}
            <Choice
              label="Replies in threads"
              value={access.replies}
              options={[
                ["everyone", "All members"],
                ["same_as_post", "Same as posting"],
              ]}
              change={(replies) => setAccess({ ...access, replies })}
            />
            <Choice
              label="Who can add people"
              value={access.invite}
              options={[
                ["members", "Any member"],
                ["managers", "Managers only"],
              ]}
              change={(invite) => setAccess({ ...access, invite })}
            />
            <fieldset>
              <legend>Managers</legend>
              {people?.map((p) => (
                <label className="block" key={p.id}>
                  <input
                    type="checkbox"
                    checked={managers.some((m) => m.id === p.id)}
                    onChange={(e) =>
                      setManagers(
                        e.target.checked
                          ? [...managers, { id: p.id, login: p.login }]
                          : managers.filter((m) => m.id !== p.id),
                      )
                    }
                  />{" "}
                  {p.login}
                </label>
              ))}
            </fieldset>
            <Choice
              label="Agents"
              value={agents}
              options={[
                ["allowed", "Allowed"],
                ["mentions_only", "Only when mentioned"],
                ["off", "Off"],
              ]}
              change={setAgents}
            />
            {closing && (
              <p>
                Saving removes {people?.filter((p) => p.admission === "outside").length ?? "all"}{" "}
                outside collaborators.
              </p>
            )}
            {channel.me.can.manage && (
              <Button type="submit" disabled={!managers.length || (closing && !people)}>
                Save settings
              </Button>
            )}
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <div className="mt-4 border-t pt-4 empty:hidden">
            <ArchiveChannel
              target={enterprise.target}
              channel={channel}
              done={() => {
                saved();
                close();
              }}
            />
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
