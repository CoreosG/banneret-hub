import type { BanneretEnrolmentView, EnvironmentId } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "../components/ui/button";
import { enrolmentRpc, useEnrolmentView } from "./enrolmentStore";
import { healthLine, outsideRefusal } from "./enterprise.logic";
import { useChatRead } from "./chat/client";
import { effectiveWorkspaceId } from "./workspaces.logic";
import { openWorkspaceDialog, useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export function OutsideNotice({
  view,
  repositories = [],
}: {
  view: BanneretEnrolmentView;
  repositories?: readonly string[];
}) {
  const refused = view.state === "revoked" ? outsideRefusal(view) : null;
  const pending = view.health === "outside_check_pending";
  if (!refused && view.me?.admission !== "outside" && !pending) return null;
  const leave = (switchAccount: boolean) =>
    openWorkspaceDialog({ kind: "leave", origin: view.relayOrigin, switchAccount });
  return (
    <aside aria-label="Outside access" className="mx-2 my-2 rounded-md border px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded bg-info/10 px-1.5 py-0.5 text-info">
        <GlobeIcon size={12} />
        {repositories.length ? "Outside · " + repositories.join(", ") : "Outside collaborator"}
      </span>
      <p className="my-1" role={refused ? "alert" : "status"}>
        {refused ??
          [
            view.me && `Signed in as ${view.me.login}.`,
            pending
              ? healthLine(view).text
              : "Your workspace shows your repositories and shared channels.",
          ]
            .filter(Boolean)
            .join(" ")}
      </p>
      <Button size="compact" variant="ghost-muted" onClick={() => leave(true)}>
        Switch account
      </Button>
      {refused && (
        <Button size="compact" variant="ghost-muted" onClick={() => leave(false)}>
          Leave
        </Button>
      )}
    </aside>
  );
}
function JoinedOutside({
  view,
  environmentId,
}: {
  view: BanneretEnrolmentView;
  environmentId: EnvironmentId;
}) {
  const names = useChatRead(async () => {
    const result = await enrolmentRpc.matchProjects(
      { environmentId, relayOrigin: view.relayOrigin },
      [],
    );
    if (!result.ok) throw new Error(result.message);
    return result.value.repositories;
  }, view.health ?? "");
  return <OutsideNotice view={view} repositories={names.value ?? []} />;
}
export function OutsideWorkspace() {
  const environmentId = usePrimaryEnvironmentId();
  const workspaces = useWorkspaces();
  const active = effectiveWorkspaceId(
    useWorkspacesStore((s) => s.activeId),
    workspaces,
  );
  const origin = workspaces.find((w) => w.id === active)?.relay?.origin;
  const view = useEnrolmentView(environmentId, origin);
  if (!view) return null;
  return environmentId && view.state === "configured" && view.me?.admission === "outside" ? (
    <JoinedOutside
      key={JSON.stringify([environmentId, origin, view.me.id])}
      view={view}
      environmentId={environmentId}
    />
  ) : (
    <OutsideNotice view={view} />
  );
}
