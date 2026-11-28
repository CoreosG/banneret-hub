import { countLabel } from "../countLabel";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { AuthEnvironmentMaintainScope, RoleDetail, type ChannelAction } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnrolmentViews } from "../enrolmentStore";
import { openWorkspaceDialog, useWorkspaces, useWorkspacesStore } from "../workspacesStore";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnterpriseFeed, type EnterpriseFeed } from "../useEnterpriseFeed";
import { chatRpc, useChatRead } from "./client";

const decode = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(RoleDetail) }));
const groups = {
  Channels: {
    "channels.seePublic": "Find public channels",
    "channels.createPublic": "Create public channels",
    "channels.createPrivate": "Create private channels",
    "channels.invite": "Add people",
    "channels.manageAll": "Manage every channel",
    "channels.openToOutside": "Open channels to outsiders",
    "channels.directoryAll": "See private channel listings",
  },
  "Direct messages": {
    "dm.group": "Start group messages",
    "dm.outsiders": "Message outside collaborators",
  },
  Agents: {
    "agents.mention": "Mention other agents",
    "agents.dm": "Message other agents",
    "agents.wakeOthers": "Wake other agents",
  },
  "Hub pages": {
    "hub.team": "Team",
    "hub.health": "Health",
    "hub.pool": "Pool",
    "hub.machinesAll": "Colleagues' machines",
  },
  Relay: { "relay.admin": "Administer relay" },
};
const internal = new Set([
  "channels.manageAll",
  "channels.openToOutside",
  "channels.directoryAll",
  "relay.admin",
]);
const blank: RoleDetail = { id: "", name: "", forOutside: false, permissions: {}, memberCount: 0 };
type Operation = Extract<ChannelAction, { kind: "roles" }>["action"];
export function WorkspaceRoles() {
  const enterprise = useEnterpriseFeed();
  const maintain = useEnvironmentScope(
    enterprise?.environmentId ?? null,
    AuthEnvironmentMaintainScope,
  );
  if (!enterprise) return <JoinForRoles />;
  if (
    !maintain ||
    !enterprise.enrolment.me?.permissions.includes("relay.admin") ||
    !enterprise.feed.sections.includes("roles")
  )
    return null;
  return <Roles key={enterprise.workspace.id} enterprise={enterprise} />;
}
function JoinForRoles() {
  const environmentId = usePrimaryEnvironmentId();
  const views = useEnrolmentViews(environmentId);
  const companies = useWorkspaces().filter((workspace) => workspace.relay);
  const activeId = useWorkspacesStore((state) => state.activeId);
  const active = companies.find((workspace) => workspace.id === activeId);
  if (!active && views.some((view) => view.state === "configured")) return null;
  const company = active ?? (companies.length === 1 ? companies[0] : undefined);
  return (
    <section className="flex items-center gap-3 px-4 py-3 text-sm">
      <span>Join {company?.relay?.displayName ?? "a company"} to manage roles</span>
      <Button
        variant="outline"
        disabled={environmentId === null}
        onClick={() =>
          openWorkspaceDialog({
            kind: "enterprise",
            ...(environmentId && { environmentId }),
            ...(company?.relay && { origin: company.relay.origin }),
          })
        }
      >
        Join
      </Button>
    </section>
  );
}
function Roles({ enterprise }: { enterprise: EnterpriseFeed }) {
  const [opened, setOpened] = useState(false);
  return (
    <section className="px-4 py-3">
      {opened ? (
        <RoleList enterprise={enterprise} close={() => setOpened(false)} />
      ) : (
        <Button variant="outline" onClick={() => setOpened(true)}>
          Roles
        </Button>
      )}
    </section>
  );
}
function RoleList({ enterprise, close }: { enterprise: EnterpriseFeed; close: () => void }) {
  const [rev, refresh] = useState(0);
  const roles = useChatRead(
    async () =>
      decode(await chatRpc.run(enterprise.target, { kind: "roles", action: { op: "list" } })).items,
    rev + ":" + (enterprise.feed.chatRevision ?? 0),
  );
  const [selection, select] = useState<string | null>(null),
    [draft, newDraft] = useState<RoleDetail | null>(null);
  const role = draft ?? roles.value?.find((r) => r.id === selection) ?? roles.value?.[0];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(action: Operation) {
    setBusy(true);
    setError("");
    try {
      await chatRpc.run(enterprise.target, { kind: "roles", action });
      newDraft(null);
      if (action.op === "save") select(action.id);
      refresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }
  return (
    <div className="grid gap-4 text-sm">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-xl font-semibold tracking-tight">Roles</h2>
        <Button
          disabled={busy || !roles.value}
          onClick={() => {
            newDraft({ ...blank });
            setError("");
          }}
        >
          New role
        </Button>
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      </header>
      <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
        <nav aria-label="Roles" className="grid content-start gap-1">
          {roles.value?.map((r) => (
            <Button
              key={r.id}
              disabled={busy}
              variant={!draft && role?.id === r.id ? "secondary" : "ghost"}
              onClick={() => {
                newDraft(null);
                select(r.id);
                setError("");
              }}
            >
              {r.name} ({r.memberCount})
            </Button>
          ))}
        </nav>
        {role && (
          <RoleEditor
            key={JSON.stringify([role, rev])}
            role={role}
            creating={!!draft}
            roles={roles.value ?? []}
            enterprise={enterprise}
            busy={busy}
            run={run}
            duplicate={() => {
              newDraft({ ...role, id: "", name: role.name + " copy", memberCount: 0 });
              setError("");
            }}
          />
        )}
      </div>
      {(roles.error || error) && <p role="alert">{error || roles.error}</p>}
    </div>
  );
}
function RoleEditor({
  role,
  creating,
  roles,
  enterprise,
  busy,
  run,
  duplicate,
}: {
  role: RoleDetail;
  creating: boolean;
  roles: readonly RoleDetail[];
  enterprise: EnterpriseFeed;
  busy: boolean;
  run: (action: Operation) => Promise<void>;
  duplicate: () => void;
}) {
  const [name, setName] = useState(role.name),
    [id, setId] = useState(role.id),
    [outside, setOutside] = useState(role.forOutside);
  const [permissions, setPermissions] = useState(role.permissions);
  const [boards, setBoards] = useState(
    Array.isArray(role.permissions["scope.boards"])
      ? role.permissions["scope.boards"].join(", ")
      : (role.permissions["scope.boards"] ?? ""),
  );
  const [person, setPerson] = useState("");
  const people = enterprise.feed.team?.value?.people ?? [];
  function set(key: string, value: true | string | undefined) {
    setPermissions((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }
  return (
    <fieldset disabled={busy} className="grid content-start gap-4 rounded-lg border p-4">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const values = { ...permissions };
          const scope = String(boards).trim();
          if (scope)
            values["scope.boards"] =
              scope === "all"
                ? scope
                : scope
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean);
          else delete values["scope.boards"];
          void run({
            op: "save",
            id,
            role: { name: name.trim(), forOutside: outside, permissions: values },
          });
        }}
      >
        {creating && (
          <label>
            Role ID
            <Input
              required
              pattern="[a-z][a-z0-9_]{0,31}"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
        )}
        <label>
          Role name
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={outside}
            onChange={(e) => {
              setOutside(e.target.checked);
              if (e.target.checked)
                setPermissions(
                  Object.fromEntries(
                    Object.entries(permissions).filter(([key]) => !internal.has(key)),
                  ),
                );
            }}
          />{" "}
          For outside collaborators
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(groups).map(([group, entries]) => (
            <fieldset key={group}>
              <legend className="font-semibold">{group}</legend>
              {Object.entries(entries).map(([key, label]) => (
                <label className="block" key={key}>
                  <input
                    type="checkbox"
                    disabled={outside && internal.has(key)}
                    checked={permissions[key] === true}
                    onChange={(e) => set(key, e.target.checked ? true : undefined)}
                  />{" "}
                  {label}
                </label>
              ))}
              {group === "Direct messages" && (
                <label>
                  Start messages with{" "}
                  <select
                    value={String(permissions["dm.start"] ?? "")}
                    onChange={(e) => set("dm.start", e.target.value || undefined)}
                  >
                    <option value="">Off</option>
                    <option value="anyone">Anyone</option>
                    <option value="shared_channel">People in shared channels</option>
                    <option value="nobody">Nobody</option>
                  </select>
                </label>
              )}
            </fieldset>
          ))}
          <fieldset>
            <legend className="font-semibold">Work and people</legend>
            <label>
              Board access
              <Input
                placeholder="all or comma-separated board IDs"
                value={String(boards)}
                onChange={(e) => setBoards(e.target.value)}
              />
            </label>
            <label>
              People{" "}
              <select
                value={String(permissions["scope.people"] ?? "")}
                onChange={(e) => set("scope.people", e.target.value || undefined)}
              >
                <option value="">Off</option>
                <option value="all">All</option>
                <option value="shared_channels">Shared channels</option>
              </select>
            </label>
          </fieldset>
        </div>
        {role.memberCount > 0 && (
          <p>
            Changes affect {countLabel(role.memberCount, "person", "people")}. They keep their
            channel memberships.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={!name.trim() || (creating && roles.some((r) => r.id === id))}
          >
            Save role
          </Button>
          {!creating && (
            <>
              <Button type="button" variant="outline" onClick={duplicate}>
                Duplicate
              </Button>
              {role.template ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void run({ op: "reset", id })}
                >
                  Reset to template
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void run({ op: "delete", id })}
                >
                  Delete role
                </Button>
              )}
            </>
          )}
        </div>
      </form>
      {!creating && (
        <form
          className="flex flex-wrap items-end gap-2 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ op: "assign", roleId: id, person });
          }}
        >
          <label>
            Assign to person
            <Input
              required
              list="role-people"
              placeholder="Person ID"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            />
          </label>
          <datalist id="role-people">
            {people
              .filter((p) => p.admission !== "outside" || outside)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.login}
                </option>
              ))}
          </datalist>
          <Button
            type="submit"
            disabled={
              !person ||
              people.some((p) => p.id === person && p.admission === "outside" && !role.forOutside)
            }
          >
            Assign role
          </Button>
        </form>
      )}
    </fieldset>
  );
}
