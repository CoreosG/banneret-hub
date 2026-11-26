// Banneret fork: which machines the "Update N machines" dialog updates. Memory only; a closed dialog
// forgets it, and every machine starts ticked. Rows that update with this app cannot be unticked.
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";

export type SkippedMachines = ReadonlySet<EnvironmentId>;

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
