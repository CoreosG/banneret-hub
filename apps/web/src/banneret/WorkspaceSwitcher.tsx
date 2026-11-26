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
import type { ReactNode } from "react";

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
import { canJoinAgain, enrolmentLine, type EnrolmentTone } from "./enterprise.logic";
import { useEnrolmentView } from "./enrolmentStore";
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
  /** The brand's own label, so the upstream string stays in use. */
  readonly ariaLabel: string;
  readonly onBackdrop: boolean;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  const active = workspaces.find((workspace) => workspace.id === activeId) ?? null;
  const activeName = active?.name ?? null;
  const enrolment = useEnrolmentView(usePrimaryEnvironmentId());
  const joinedHere =
    active?.relay !== undefined &&
    enrolment?.workspaceId === active.id &&
    enrolment.state === "configured";

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={props.ariaLabel}
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
              enrolment={enrolment}
            />
          ))}
        </MenuRadioGroup>
        {active?.relay !== undefined ? (
          <>
            <MenuSeparator />
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
            {joinedHere ? (
              <>
                <MenuItem onClick={() => openWorkspaceDialog({ kind: "machines" })}>
                  <LaptopIcon />
                  Machines…
                </MenuItem>
                <MenuItem onClick={() => openWorkspaceDialog({ kind: "leave" })}>
                  <LogOutIcon />
                  Leave…
                </MenuItem>
              </>
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
                {enrolment?.workspaceId === active.id && enrolment.state !== "none"
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
        <MenuItem onClick={() => void navigate({ to: "/" })}>
          <HouseIcon />
          Home
        </MenuItem>
      </MenuPopup>
    </Menu>
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
  return (
    <MenuRadioItem value={props.value} closeOnClick>
      <span className="flex min-w-0 items-center gap-2">
        {line !== null ? (
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[line.tone])} />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{props.name}</span>
          {line !== null ? (
            <span className="truncate text-muted-foreground text-xs">{line.text}</span>
          ) : null}
        </span>
        <MenuRadioItemIndicator />
      </span>
    </MenuRadioItem>
  );
}
