import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { UpdateEverythingDialog } from "~/components/sidebar/UpdateEverythingDialog";
import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";

const rows: ReadonlyArray<UpdateEverythingRow> = ["alpha", "beta", "gamma"].map((label) => ({
  environmentId: label as EnvironmentId,
  label,
  app: "server",
  skipped: null,
  providers: [],
}));

function open(onConfirm = vi.fn()) {
  return {
    onConfirm,
    screen: render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => {}}
        version="1.0.0"
        providerCount={0}
        rows={rows}
        restarts={[]}
        selectable
        onConfirm={onConfirm}
      />,
    ),
  };
}

describe("update dialog machine selection", () => {
  it("starts with every machine ticked and updates the unticked ones' complement", async () => {
    const { screen: pending, onConfirm } = open();
    await using _screen = await pending;
    await expect.element(page.getByRole("button", { name: "Update 3 machines" })).toBeVisible();

    await userEvent.click(page.getByRole("checkbox", { name: "beta" }));
    await userEvent.click(page.getByRole("button", { name: "Update 2 machines" }));
    expect(onConfirm).toHaveBeenCalledWith(new Set(["beta"]));
  });

  it("disables the button when nothing is ticked", async () => {
    const { screen: pending } = open();
    await using _screen = await pending;
    for (const name of ["alpha", "beta", "gamma"]) {
      await userEvent.click(page.getByRole("checkbox", { name }));
    }
    await expect.element(page.getByRole("button", { name: "Update 0 machines" })).toBeDisabled();
  });
});
