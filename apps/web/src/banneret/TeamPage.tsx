import type { ReactNode } from "react";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { FeedStatus } from "./FeedParts";
import { offersSection } from "./relayFeed.logic";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { PageHeader } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { LAYOUT_PAGE } from "./ui/tokens";
import { DeskEnterprise } from "./offices/DeskDetails";
import { OfficeViews } from "./offices/OfficeViews";
/** The page fills the window; only the people panel scrolls. */
function TeamFrame(props: { readonly company?: string; readonly children: ReactNode }) {
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          {props.company === undefined ? null : (
            <>
              <span className="truncate text-muted-foreground">{props.company}</span>
              <span aria-hidden className="text-muted-foreground">
                /
              </span>
            </>
          )}
          <span className="font-medium">Team</span>
        </span>
      </WorkspacePageHeader>
      <div
        className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 px-6 pt-6 pb-8"
        {...LAYOUT_PAGE}
      >
        {props.children}
      </div>
    </SidebarInset>
  );
}

export function TeamPage() {
  const enterprise = useEnterpriseFeed();
  if (enterprise === null) {
    return (
      <TeamFrame>
        <PageHeader title="Team" />
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </TeamFrame>
    );
  }
  const { feed, workspace } = enterprise;
  if (!offersSection(feed, "team")) {
    return (
      <TeamFrame company={workspace.name}>
        <PageHeader title="Team" />
        <QuietLine fact={`${workspace.name} does not offer a team view.`} />
      </TeamFrame>
    );
  }
  const read = feed.team;
  return (
    <TeamFrame company={workspace.name}>
      <PageHeader title="Team" />
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      {read?.value?.office ? (
        <DeskEnterprise value={enterprise}>
          <OfficeViews
            key={enterprise.environmentId + workspace.id}
            enterprise={enterprise}
            people={read.value.people}
            office={read.value.office}
          />
        </DeskEnterprise>
      ) : read?.problem ? null : (
        <p>Loading team…</p>
      )}
    </TeamFrame>
  );
}
