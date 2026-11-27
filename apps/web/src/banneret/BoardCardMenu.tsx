// Banneret Hub: a board card's menu. Take, Continue, Release, Finish and Withdraw follow the server's
// `leases.check`, read only when the menu opens, never for every card on the board.
import type { BanneretBoardCard, BanneretBoardTask } from "@t3tools/contracts";
import { EllipsisVerticalIcon } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { taskRef } from "./board.logic";
import type { RelayTarget } from "./enrolmentStore";
import { isFreeToContinue } from "./lease.logic";
import { useLeaseCheck } from "./LeaseControls";
import { openReleaseDialog, runLease, useLeaseEntry } from "./leaseStore";
import { useTaskIssueRef } from "./useTaskIssueRef";

function LeaseItems(props: {
  readonly target: RelayTarget;
  readonly card: BanneretBoardCard;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const { card, target } = props;
  const issueRef = useTaskIssueRef(target.environmentId, card.task);
  const entry = useLeaseCheck(target, card.task.id, issueRef, true);
  if (issueRef === null) {
    return (
      <MenuItem disabled data-testid="lease-menu-off">
        Take needs a local project for {taskRef(card.task).repo}
      </MenuItem>
    );
  }
  const status = entry?.status ?? null;
  if (status === null) {
    return (
      <MenuItem disabled data-testid="lease-menu-off">
        {entry?.notice?.message ?? "Checking who holds it…"}
      </MenuItem>
    );
  }
  if (status.availability !== "available") {
    return (
      <MenuItem disabled data-testid="lease-menu-off">
        {status.detail ?? "Take and release are off for this task."}
      </MenuItem>
    );
  }
  const running = entry?.phase.kind === "running" || status.busy;
  const run = (operation: "take" | "finish" | "withdraw") =>
    void runLease(target, card.task.id, issueRef, operation);
  const items = [
    status.actions.take
      ? isFreeToContinue(card)
        ? // Continue shows the last holder's note first, in the Task dialog, then takes from there.
          { id: "continue", label: "Continue…", act: () => props.onOpen(card.task) }
        : { id: "take", label: "Take", act: () => run("take") }
      : null,
    status.actions.release
      ? {
          id: "release",
          label: "Release…",
          act: () =>
            openReleaseDialog({
              relay: target,
              taskId: card.task.id,
              title: card.task.title,
              ref: issueRef,
            }),
        }
      : null,
    status.actions.finish ? { id: "finish", label: "Finish", act: () => run("finish") } : null,
    status.actions.withdraw
      ? { id: "withdraw", label: "Withdraw", act: () => run("withdraw") }
      : null,
  ].filter((item) => item !== null);
  if (items.length === 0) {
    const holder = status.lease?.holder;
    return (
      <MenuItem disabled data-testid="lease-menu-off">
        {holder === undefined ? "Nothing to do here." : `${holder} holds this task.`}
      </MenuItem>
    );
  }
  return items.map((item) => (
    <MenuItem key={item.id} disabled={running} data-lease-action={item.id} onClick={item.act}>
      {item.label}
    </MenuItem>
  ));
}

export function BoardCardMenu(props: {
  readonly target: RelayTarget;
  readonly card: BanneretBoardCard;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const entry = useLeaseEntry(props.target, props.card.task.id);
  const running = entry?.phase.kind === "running";
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Actions for ${props.card.task.title}`}
            className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <EllipsisVerticalIcon aria-hidden className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={4} className="min-w-48">
        <MenuItem onClick={() => props.onOpen(props.card.task)}>Open task</MenuItem>
        <MenuSeparator />
        {running ? (
          <MenuItem disabled data-testid="lease-menu-off">
            A change to this task is running…
          </MenuItem>
        ) : (
          <LeaseItems target={props.target} card={props.card} onOpen={props.onOpen} />
        )}
      </MenuPopup>
    </Menu>
  );
}
