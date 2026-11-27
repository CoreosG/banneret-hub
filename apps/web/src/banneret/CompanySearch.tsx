// Banneret Hub: the `/` search over the active workspace's company, through the snapshot data the feed
// already holds; it asks the relay for nothing. Enter opens the highlighted result: a card in the Task
// dialog, a map item in its Map neighbourhood (else its task or the filtered Map), a feed entry in its
// task or at its link.
import type { BanneretBoardTask } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Kbd } from "../components/ui/kbd";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { cn } from "../lib/utils";
import { taskRef } from "./board.logic";
import { opensSearch, searchCompany } from "./boards.logic";
import { mergeFeedEntries } from "./feed.logic";
import { neighbourhoodSearch } from "./mapGraph.logic";
import { safeLinkOut } from "./relayFeed.logic";
import { StatusMark } from "./StatusLegend";
import {
  closeCompanySearch,
  openCompanySearch,
  setCompanySearchAvailable,
  useCompanySearchStore,
} from "./companySearchStore";
import { type EnterpriseFeed, useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";

/** One result row. `open` runs after the dialog closes. */
export interface CompanySearchHit {
  readonly key: string;
  readonly group: string;
  readonly title: string;
  readonly detail: string;
  readonly status?: string | undefined;
  readonly open: () => void;
}

export interface CompanySearchContext {
  readonly query: string;
  readonly enterprise: EnterpriseFeed;
  readonly openTask: (task: BanneretBoardTask) => void;
  readonly navigate: ReturnType<typeof useNavigate>;
}

/** A kind of thing the search finds, as rows in its own groups. */
export type CompanySearchSource = (
  context: CompanySearchContext,
) => ReadonlyArray<CompanySearchHit>;

/** Every board's cards, the map's items and the feed's entries. */
const boardsMapFeed: CompanySearchSource = ({ query, enterprise, openTask, navigate }) => {
  const { feed } = enterprise;
  const hits = searchCompany(query, {
    boards: feed.board?.value ?? null,
    map: feed.map?.value ?? null,
    feed: mergeFeedEntries(feed.activity?.value?.entries ?? [], feed.activityOlder?.entries ?? []),
  });
  return [
    ...hits.cards.map(({ boardTitle, card }) => {
      const ref = taskRef(card.task);
      return {
        key: `card:${card.task.id}`,
        group: "Board cards",
        title: card.task.title,
        detail: `${boardTitle} · ${ref.repo} ${ref.number}`,
        status: card.status,
        open: () => openTask(card.task),
      };
    }),
    ...hits.mapItems.map((item) => {
      const stage = feed.map?.value?.stages.find((candidate) => candidate.id === item.stageId);
      return {
        key: `map:${item.id}`,
        group: "Map items",
        title: item.title,
        detail: stage === undefined ? "Build map" : `Build map · ${stage.title}`,
        status: item.status,
        open: () => {
          if (feed.map?.restsOn === true)
            void navigate({ to: "/map", search: neighbourhoodSearch(item.id) } as never);
          else if (item.task !== undefined) openTask(item.task);
          else void navigate({ to: "/map", search: { q: item.title } } as never);
        },
      };
    }),
    ...hits.feed.map((entry) => {
      const link = safeLinkOut(entry.link);
      return {
        key: `feed:${entry.id}`,
        group: "Feed",
        title: entry.summary,
        detail: entry.task === undefined ? "Feed" : `Feed · ${entry.task.title}`,
        status: entry.status,
        open: () => {
          if (entry.task !== undefined) openTask(entry.task);
          else if (link !== null) window.open(link, "_blank", "noopener,noreferrer");
          else void navigate({ to: "/feed", search: { q: entry.summary } } as never);
        },
      };
    }),
  ];
};

/** Every source, in result order. A page with its own kind of thing (people, say) adds one here. */
const COMPANY_SEARCH_SOURCES: ReadonlyArray<CompanySearchSource> = [boardsMapFeed];

function SearchBody(props: { readonly enterprise: EnterpriseFeed }) {
  const { target, workspace } = props.enterprise;
  const openTask = useOpenTask(target);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const context = { query, enterprise: props.enterprise, openTask, navigate };
  const list: ReadonlyArray<CompanySearchHit> = COMPANY_SEARCH_SOURCES.flatMap((source) =>
    source(context),
  ).map((hit) => ({
    ...hit,
    open: () => {
      closeCompanySearch();
      hit.open();
    },
  }));
  const active = list.length === 0 ? -1 : Math.min(highlight, list.length - 1);
  const groups = [...new Set(list.map((hit) => hit.group))];
  return (
    <>
      <DialogTitle className="sr-only">Search {workspace.name}</DialogTitle>
      <label className="flex items-center gap-2 border-b px-4 py-3">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded={list.length > 0}
          aria-controls="company-search-results"
          aria-activedescendant={active < 0 ? undefined : `company-search-${active}`}
          aria-label={`Search ${workspace.name}`}
          placeholder="Search tasks, the map and the feed"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight(Math.min(active + 1, list.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight(Math.max(active - 1, 0));
            } else if (event.key === "Enter" && active >= 0) {
              event.preventDefault();
              list[active]?.open();
            }
          }}
        />
        <Kbd>Esc</Kbd>
      </label>
      <div
        id="company-search-results"
        role="listbox"
        aria-label="Results"
        className="max-h-96 overflow-y-auto p-2"
      >
        {query.trim() === "" ? (
          <p className="px-2 py-3 text-muted-foreground text-sm">
            Type to search every board, the map and the feed.
          </p>
        ) : list.length === 0 ? (
          <p className="px-2 py-3 text-muted-foreground text-sm">Nothing matches.</p>
        ) : (
          groups.map((group) => (
            <div key={group} role="group" aria-label={group} className="flex flex-col">
              <p className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">{group}</p>
              {list.map((hit, index) =>
                hit.group !== group ? null : (
                  <div
                    key={hit.key}
                    id={`company-search-${index}`}
                    role="option"
                    aria-selected={index === active}
                    tabIndex={-1}
                    data-hit={hit.key}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                      index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                    )}
                    onMouseMove={() => setHighlight(index)}
                    onClick={hit.open}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") hit.open();
                    }}
                  >
                    {hit.status === undefined ? null : <StatusMark status={hit.status} />}
                    <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                    <span className="shrink-0 truncate text-muted-foreground text-xs">
                      {hit.detail}
                    </span>
                  </div>
                ),
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * The dialog and its `/` key, for the whole app: WorkspacesHost mounts it once, so the key works on
 * every page whether or not the sidebar is shown. It is off without a joined company, and on Settings
 * and Usage, which keep `/` for their own search.
 */
export function CompanySearchHost() {
  const enterprise = useEnterpriseFeed();
  const onModalPage = isAppModalPage(useLocation({ select: (location) => location.pathname }));
  const available = enterprise !== null && !onModalPage;
  const open = useCompanySearchStore((state) => state.open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the openers whether there is a company to search, and owns the one document key listener
  useEffect(() => {
    setCompanySearchAvailable(available);
    if (!available) return;
    const onKey = (event: KeyboardEvent) => {
      if (!opensSearch(event)) return;
      event.preventDefault();
      openCompanySearch();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      setCompanySearchAvailable(false);
    };
  }, [available]);
  return (
    <Dialog
      open={open && enterprise !== null}
      onOpenChange={(next) => (next ? openCompanySearch() : closeCompanySearch())}
    >
      {open && enterprise !== null ? (
        <DialogPopup
          showCloseButton={false}
          className="max-w-xl overflow-hidden"
          data-testid="company-search"
        >
          <SearchBody enterprise={enterprise} />
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
