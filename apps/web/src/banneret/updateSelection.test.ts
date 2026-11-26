import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";
import {
  countSelected,
  isSelectableRow,
  updateButtonLabel,
  withoutSkipped,
} from "./updateSelection";

const id = (value: string) => value as EnvironmentId;
const row = (
  value: string | null,
  app: UpdateEverythingRow["app"] = "server",
): UpdateEverythingRow => ({
  environmentId: value === null ? null : id(value),
  label: value ?? "This app",
  app,
  skipped: null,
  providers: [],
});

describe("update selection", () => {
  const rows = [row("a"), row("b"), row("c")];

  it("counts every machine when none is unticked", () => {
    expect(countSelected(rows, new Set())).toBe(3);
    expect(updateButtonLabel(3)).toBe("Update 3 machines");
  });

  it("leaves unticked machines out", () => {
    const skipped = new Set([id("b")]);
    expect(countSelected(rows, skipped)).toBe(2);
    expect(
      withoutSkipped([{ environmentId: id("a") }, { environmentId: id("b") }], skipped),
    ).toEqual([{ environmentId: id("a") }]);
    expect(updateButtonLabel(1)).toBe("Update 1 machine");
  });

  it("reaches zero when all are unticked", () => {
    expect(countSelected(rows, new Set([id("a"), id("b"), id("c")]))).toBe(0);
  });

  it("keeps rows that update with this app", () => {
    expect(isSelectableRow(row(null, "this-app"))).toBe(false);
    expect(isSelectableRow(row("d", "desktop-app"))).toBe(false);
    expect(isSelectableRow(row("a"))).toBe(true);
  });
});
