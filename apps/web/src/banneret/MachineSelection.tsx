import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";
import { Checkbox as RowCheckbox } from "~/components/ui/checkbox";
import {
  countSelected,
  isSelectableRow,
  type SkippedMachines,
  updateButtonLabel,
  useUpdateSelection,
} from "./updateSelection";

export interface Props {
  readonly selectable?: boolean;
  readonly onConfirm: (skipped: SkippedMachines) => void;
}

export function useSelection(
  rows: readonly UpdateEverythingRow[],
  selectable: boolean,
  onConfirm: Props["onConfirm"],
) {
  const { skipped, toggle } = useUpdateSelection();
  const count = selectable ? countSelected(rows, skipped) : rows.length;
  return {
    count,
    skipped,
    toggle,
    selectable,
    label: selectable ? updateButtonLabel(count) : null,
    confirmButton: (disabled: boolean) => ({
      disabled: disabled || (selectable && count === 0),
      onClick: () => onConfirm(skipped),
    }),
  };
}

export function Checkbox({
  row,
  selection,
}: {
  row: UpdateEverythingRow;
  selection: ReturnType<typeof useSelection>;
}) {
  const id = row.environmentId;
  if (!selection.selectable || id === null || !isSelectableRow(row)) return null;
  return (
    <RowCheckbox
      checked={!selection.skipped.has(id)}
      onCheckedChange={() => selection.toggle(id)}
      aria-label={row.label}
    />
  );
}
