// Banneret fork: which machines the "Update N machines" dialog updates. Memory only; a closed dialog
// forgets it, and every machine starts ticked. Rows that update with this app cannot be unticked.
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";

export type SkippedMachines = ReadonlySet<EnvironmentId>;

export interface ProviderUpdateOptions {
  readonly quiet?: boolean;
  readonly skipped?: SkippedMachines;
}

export const isSelectableRow = (row: UpdateEverythingRow) =>
  row.environmentId !== null && row.app !== "this-app" && row.app !== "desktop-app";

export const countSelected = (rows: ReadonlyArray<UpdateEverythingRow>, skipped: SkippedMachines) =>
  rows.filter((row) => row.environmentId === null || !skipped.has(row.environmentId)).length;

export const withoutSkipped = <T extends { readonly environmentId: EnvironmentId }>(
  items: ReadonlyArray<T>,
  skipped: SkippedMachines,
) => items.filter((item) => !skipped.has(item.environmentId));

export const updateButtonLabel = (count: number) =>
  `Update ${count} ${count === 1 ? "machine" : "machines"}`;

export function useUpdateSelection() {
  const [skipped, setSkipped] = useState<SkippedMachines>(new Set());
  const toggle = (id: EnvironmentId) =>
    setSkipped((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return { skipped, toggle };
}

/**
 * The Banneret Hub column: "1.2.17 → 1.2.19" for a machine that updates, "Up to date" for one that
 * only updates providers, null (the kind label alone) when the versions are unknown or equal, as on a
 * track switch. `target` is the dialog's version: this app's, else the first server's.
 */
export function hubVersionLabel(
  row: UpdateEverythingRow,
  current: string | undefined,
  target: string | null,
): string | null {
  if (row.app === null) return row.skipped === null ? "Up to date" : null;
  if (row.app === "desktop-app" || target === null) return null;
  if (current === undefined) return `→ ${target}`;
  return current === target ? null : `${current} → ${target}`;
}
