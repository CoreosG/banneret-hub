// Banneret Hub: the sidebar brand mark doubles as the workspace switcher.
import { useNavigate } from "@tanstack/react-router";
import type { BanneretEnrolmentView, BanneretWorkspace } from "@t3tools/contracts";
import {
  ChevronsUpDownIcon,
  HouseIcon,
  LaptopIcon,
  LogOutIcon,
  PlusIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { PresencePrompt } from "./offices/OfficeSettings";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  canJoinAgain,
  enrolmentLine,
  type EnrolmentTone,
  joinLine,
  roleLabel,
  pendingJoins,
} from "./enterprise.logic";
import { useEnrolmentViews } from "./enrolmentStore";
import { useGitHubLogin, accountMatch } from "./accountIdentity";
import { effectiveWorkspaceId } from "./workspaces.logic";
import {
  openWorkspaceDialog,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesStore,
} from "./workspacesStore";

// Radio values are strings; Personal has no id of its own.
const PERSONAL_VALUE = "";

export function WorkspaceSwitcher(props: {
  /** Upstream's brand-link label, kept on the Home item so the upstream string stays in use. */
  readonly homeLabel: string;
  readonly onBackdrop: boolean;
  readonly children: ReactNode;
}) {
  const [presenceOpen, showPresence] = useState(false);
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  const active = workspaces.find((workspace) => workspace.id === activeId) ?? null;
  const activeName = active?.name ?? null;
  // Each Enterprise workspace has its own relay, so its own enrolment on this machine.
  const views = useEnrolmentViews(usePrimaryEnvironmentId());
  const viewOf = (workspace: BanneretWorkspace) =>
    views.find((view) => view.workspaceId === workspace.id) ?? null;
  const enrolment = active === null ? null : viewOf(active);
  const joinedHere = active?.relay !== undefined && enrolment?.state === "configured";
  const enterprise = useEnterpriseFeed();
  const team = enterprise?.feed.team?.value;
  const me = team?.office?.flags.some((f) => f === "presence" || f === "status")
    ? team.people.find((p) => p.login === enrolment?.me?.login)
    : undefined;
  const pending = pendingJoins(views, workspaces);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Switch workspace"
              className={cn(
                "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-md px-1 outline-hidden ring-ring [-webkit-app-region:no-drag] hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset md:flex",
                props.onBackdrop ? "text-white hover:bg-white/10" : "text-foreground",
              )}
            />
          }
        >
          {props.children}
          {activeName ? (
            <span
              className={cn(
                "min-w-0 truncate text-xs",
                props.onBackdrop ? "text-white/70" : "text-muted-foreground",
              )}
            >
              {activeName}
            </span>
          ) : null}
          <ChevronsUpDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0",
              props.onBackdrop ? "text-white/70" : "text-muted-foreground",
            )}
          />
        </MenuTrigger>
        <MenuPopup align="start" sideOffset={6} className="min-w-56">
          <MenuRadioGroup
            value={activeId ?? PERSONAL_VALUE}
            onValueChange={(value) => setActiveWorkspace(value === PERSONAL_VALUE ? null : value)}
          >
            <WorkspaceRadioItem value={PERSONAL_VALUE} name="Personal" />
            {workspaces.map((workspace) => (
              <WorkspaceRadioItem
                key={workspace.id}
                value={workspace.id}
                name={workspace.name}
                workspace={workspace}
                enrolment={viewOf(workspace)}
              />
            ))}
          </MenuRadioGroup>
          {pending.map((view) => (
            <PendingJoinItem key={view.relayOrigin} view={view} />
          ))}
          {active?.relay !== undefined ? (
            <>
              <MenuSeparator />
              {me && <MenuItem onClick={() => showPresence(true)}>My presence…</MenuItem>}
              {joinedHere && canJoinAgain(enrolment) ? (
                <MenuItem
                  onClick={() =>
                    openWorkspaceDialog(
                      active.relay === undefined
                        ? { kind: "enterprise" }
                        : { kind: "enterprise", origin: active.relay.origin },
                    )
                  }
                >
                  <UsersIcon />
                  Join again…
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() =>
                  active.relay !== undefined &&
                  openWorkspaceDialog({ kind: "machines", origin: active.relay.origin })
                }
              >
                <LaptopIcon />
                Machines…
              </MenuItem>
              {joinedHere ? (
                <MenuItem
                  onClick={() =>
                    active.relay !== undefined &&
                    openWorkspaceDialog({ kind: "leave", origin: active.relay.origin })
                  }
                >
                  <LogOutIcon />
                  Leave…
                </MenuItem>
              ) : (
                <MenuItem
                  onClick={() =>
                    openWorkspaceDialog(
                      active.relay === undefined
                        ? { kind: "enterprise" }
                        : { kind: "enterprise", origin: active.relay.origin },
                    )
                  }
                >
                  <UsersIcon />
                  {enrolment !== null && enrolment.state !== "none"
                    ? "Enrolment…"
                    : "Join on this machine…"}
                </MenuItem>
              )}
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => openWorkspaceDialog({ kind: "create" })}>
            <PlusIcon />
            New workspace…
          </MenuItem>
          <MenuItem onClick={() => openWorkspaceDialog({ kind: "manage", workspaceId: activeId })}>
            <Settings2Icon />
            Manage workspaces
          </MenuItem>
          <MenuSeparator />
          <MenuItem aria-label={props.homeLabel} onClick={() => void navigate({ to: "/" })}>
            <HouseIcon />
            Home
          </MenuItem>
        </MenuPopup>
      </Menu>
      {enterprise && me && (
        <PresencePrompt
          key={JSON.stringify([enterprise.environmentId, enterprise.workspace.id, me.id])}
          enterprise={enterprise}
          person={me}
          open={presenceOpen}
          close={() => showPresence(false)}
        />
      )}
    </>
  );
}

// The active workspace carries a check, as upstream's selection menus do. Picking one closes the
// menu, since the sidebar behind it changes.
const TONE_DOT: Record<EnrolmentTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

/** A join with no workspace yet: its own progress, and a way back to its join screen. */
function PendingJoinItem(props: { readonly view: BanneretEnrolmentView }) {
  const { view } = props;
  const line = joinLine(view);
  return (
    <MenuItem onClick={() => openWorkspaceDialog({ kind: "enterprise", origin: view.relayOrigin })}>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[line.tone])} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{view.displayName ?? view.relayOrigin}</span>
          <span className="truncate text-muted-foreground text-xs">{line.text}</span>
        </span>
      </span>
    </MenuItem>
  );
}

function WorkspaceRadioItem(props: {
  readonly value: string;
  readonly name: string;
  readonly workspace?: BanneretWorkspace;
  readonly enrolment?: BanneretEnrolmentView | null;
}) {
  const line =
    props.workspace?.relay !== undefined
      ? enrolmentLine(props.workspace, props.enrolment ?? null)
      : null;
  const primary = usePrimaryEnvironmentId();
  const login = useGitHubLogin(props.enrolment?.me ? primary : null);
  const mismatch = accountMatch(login, props.enrolment?.me?.login) === false;
  return (
    <MenuRadioItem value={props.value} closeOnClick>
      <span className="flex min-w-0 items-center gap-2">
        {line !== null ? (
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[line.tone])} />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{props.name}</span>
          {line !== null ? (
            <span className="text-muted-foreground text-xs">
              <span>
                {props.enrolment?.health === "healthy" && props.enrolment.me?.login.trim() ? (
                  <>
                    Signed in as <strong>{props.enrolment.me.login.trim()}</strong>
                    {props.enrolment.me.role.trim() && ` · ${roleLabel(props.enrolment.me.role)}`}
                  </>
                ) : (
                  line.text
                )}
              </span>
              {mismatch && <span className="text-warning"> · GitHub: {login}</span>}
            </span>
          ) : null}
        </span>
        <MenuRadioItemIndicator />
      </span>
    </MenuRadioItem>
  );
}
