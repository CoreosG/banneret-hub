import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";
import {
  countSelected,
  hubVersionLabel,
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

describe("hubVersionLabel", () => {
  it("names the versions a machine moves between", () => {
    expect(hubVersionLabel(row("a"), "1.2.17", "1.2.19")).toBe("1.2.17 \u2192 1.2.19");
    // An updating row never reads "Up to date": equal or unknown versions leave the kind label.
    expect(hubVersionLabel(row("a"), "1.2.19", "1.2.19")).toBeNull();
    expect(hubVersionLabel(row("a"), undefined, "1.2.19")).toBe("\u2192 1.2.19");
    expect(hubVersionLabel(row("a"), "1.2.17", null)).toBeNull();
  });

  it("says a provider-only machine is up to date, and leaves a desktop app's version to it", () => {
    expect(hubVersionLabel(row("a", null), "1.2.19", "1.2.19")).toBe("Up to date");
    expect(hubVersionLabel({ ...row("a", null), skipped: "Offline" }, undefined, null)).toBeNull();
    expect(hubVersionLabel(row("d", "desktop-app"), "1.2.17", "1.2.19")).toBeNull();
  });
});
