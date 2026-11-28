// Banneret Hub: what the chats bar and the workspaces bar share: the sortable strip, its options
// menu, a tab's look and its arrow keys. Drag reorders with pointer events (dnd-kit), since HTML5
// drag events miss the desktop window's drag region on Windows.
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { EllipsisIcon } from "lucide-react";
import { useEffect, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { setTabsHidden } from "./tabsStore";

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

export const tabClassName = (tab: {
  active: boolean;
  offline: boolean;
  dragging: boolean;
  preview?: boolean;
}) =>
  cn(
    "group/tab relative flex h-7 max-w-52 min-w-0 shrink-0 cursor-default select-none items-center gap-1 rounded-md border border-transparent ps-2 pe-1 text-xs [-webkit-app-region:no-drag]",
    tab.active
      ? "border-border bg-accent text-foreground"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
    tab.preview && "italic",
    tab.offline && "opacity-50",
    tab.dragging && "z-10",
  );

export const TAB_BUTTON_CLASS_NAME =
  "flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted";

/** Left and right arrows move focus along the strip. */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const items = [
    ...event.currentTarget
      .closest('[role="tablist"]')!
      .querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  const step = event.key === "ArrowLeft" ? -1 : 1;
  items[items.indexOf(event.currentTarget) + step]?.focus();
}

/** Keeps the active tab, and so its close button, inside a bar that scrolls sideways. */
export function useKeepTabInView(item: RefObject<HTMLElement | null>, active: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the bar to its active tab
  useEffect(() => {
    const tab = item.current;
    const list = tab?.closest('[role="tablist"]');
    if (!active || !tab || !list) return;
    // Reports once on observe, then whenever the tab or the bar changes width.
    return observeResize([tab, list], () =>
      tab.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }, [active, item]);
}

export function TabStrip(props: {
  label: string;
  ids: ReadonlyArray<string>;
  /** `id` was dropped before `beforeId`, or at the end for null. */
  onMove: (id: string, beforeId: string | null) => void;
  /** The tab menu. Outside the tabs, so its clicks never bubble into one. */
  menu: ReactNode;
  children: ReactNode;
}) {
  const { ids } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    // Dropped on a tab to its right: it lands after that tab; to its left: before it.
    props.onMove(String(active.id), from < to ? (ids[to + 1] ?? null) : ids[to]!);
  };

  return (
    <>
      <div
        role="tablist"
        aria-label={props.label}
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={TAB_DRAG_MODIFIERS}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={[...ids]} strategy={horizontalListSortingStrategy}>
            {props.children}
          </SortableContext>
        </DndContext>
      </div>
      {props.menu}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Tabs bar options"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6}>
          <MenuItem onClick={() => setTabsHidden(true)}>Hide tabs bar</MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
