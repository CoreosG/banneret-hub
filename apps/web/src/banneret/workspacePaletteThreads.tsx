// Banneret Hub: the command palette's threads follow the active workspace, like the sidebar. A
// search that also matches other workspaces' threads ends with one row that widens it to them all.
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import { LayersIcon } from "lucide-react";
import { useState } from "react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../components/CommandPalette.logic";
import { useVisibleThreadShells } from "../state/entities";
import { useWorkspaceScopedThreads } from "./useWorkspaceScopedThreads";

const OTHER_WORKSPACES_VALUE = "banneret:other-workspace-threads";

/**
 * How many threads outside the workspace the query matches, by title or by message. The title
 * pass ranks every thread together, as the palette does, so a typo fallback cannot count rows
 * that widening would not show.
 */
function countOtherWorkspaceMatches(input: {
  readonly threadItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly threadMessageItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly inWorkspace: (item: CommandPaletteActionItem) => boolean;
  readonly query: string;
  readonly now: number;
}): number {
  if (input.query.startsWith(">")) return 0;
  const normalizedQuery = foldSearchQuery(input.query);
  if (normalizedQuery.length === 0) return 0;
  const matched = new Set(
    rankSearchItems(input.threadItems, (item, options) =>
      item.threadSearch
        ? scoreThreadSearch(normalizedQuery, item.threadSearch, input.now, options)
        : null,
    ).map(({ item }) => item),
  );
  const others = new Set<string>();
  for (const item of [...matched, ...input.threadMessageItems]) {
    if (!input.inWorkspace(item)) others.add(item.value);
  }
  return others.size;
}

/**
 * Narrows the palette's thread rows to the active workspace until the person widens them, and
 * offers that widening as the last row of a search. Widening lasts for this palette session.
 */
export function useWorkspacePaletteThreads<
  TThreads extends {
    readonly threadItems: ReadonlyArray<CommandPaletteActionItem>;
    readonly threadMessageItems: ReadonlyArray<CommandPaletteActionItem>;
    readonly now: number;
  },
>(threads: TThreads, query: string) {
  const shells = useVisibleThreadShells();
  const scopedShells = useWorkspaceScopedThreads(shells);
  const [widened, setWidened] = useState(false);
  const unchanged = (groups: ReadonlyArray<CommandPaletteGroup>, _searching?: boolean) => groups;
  // The recent list (no query) stays scoped even after a search was widened.
  if ((widened && query.trim().length > 0) || scopedShells.length === shells.length) {
    return { ...threads, withOtherWorkspaces: unchanged };
  }

  const shown = new Set(scopedShells.map((thread) => `${thread.environmentId}:${thread.id}`));
  const inWorkspace = (item: CommandPaletteActionItem) =>
    item.threadRef === undefined ||
    shown.has(`${item.threadRef.environmentId}:${item.threadRef.threadId}`);
  const count = countOtherWorkspaceMatches({ ...threads, inWorkspace, query });
  const widenItem: CommandPaletteActionItem = {
    kind: "action",
    value: OTHER_WORKSPACES_VALUE,
    searchTerms: [],
    title: `Show ${count} ${count === 1 ? "result" : "results"} in other workspaces`,
    icon: <LayersIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => setWidened(true),
  };
  return {
    ...threads,
    threadItems: threads.threadItems.filter(inWorkspace),
    threadMessageItems: threads.threadMessageItems.filter(inWorkspace),
    /** `searching` is false where the palette lists other threads, such as a linked-thread search. */
    withOtherWorkspaces: (groups: ReadonlyArray<CommandPaletteGroup>, searching = true) =>
      count === 0 || !searching
        ? groups
        : [
            ...groups,
            { value: OTHER_WORKSPACES_VALUE, label: "Other workspaces", items: [widenItem] },
          ],
  };
}
