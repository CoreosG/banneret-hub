import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { UpdateEverythingDialog } from "~/components/sidebar/UpdateEverythingDialog";
import type { UpdateEverythingRow } from "~/components/sidebar/updateEverything.logic";
import { useServerConfigs } from "~/state/entities";

vi.mock("~/state/entities", { spy: true });

const MAC = "Ada's MacBook Pro (Studio, second floor)";
const rows: ReadonlyArray<UpdateEverythingRow> = ["alpha", "beta", MAC].map((label) => ({
  environmentId: label as EnvironmentId,
  label,
  app: "server",
  skipped: null,
  providers: [],
}));

function open(onConfirm = vi.fn()) {
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      ["alpha", { environment: { serverVersion: "0.9.0" } }],
      ["beta", { environment: { serverVersion: "1.0.0" } }],
    ]) as unknown as ReturnType<typeof useServerConfigs>,
  );
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
    // The heading follows the ticked count, as the button does.
    await expect.element(page.getByRole("heading", { name: "Update 2 machines?" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Update 2 machines" }));
    expect(onConfirm).toHaveBeenCalledWith(new Set(["beta"]));
  });

  it("disables the button when nothing is ticked", async () => {
    const { screen: pending } = open();
    await using _screen = await pending;
    for (const name of ["alpha", "beta", MAC]) {
      await userEvent.click(page.getByRole("checkbox", { name }));
    }
    await expect.element(page.getByRole("button", { name: "Update 0 machines" })).toBeDisabled();
  });
});

describe("update dialog rows", () => {
  it("shows each machine's versions and gives a long name the width it needs", async () => {
    const { screen: pending } = open();
    await using _screen = await pending;
    await page.viewport(1280, 800);
    await expect.element(page.getByText("0.9.0 \u2192 1.0.0")).toBeVisible();
    // A machine already on the target keeps only its kind, never "Up to date" while it updates.
    const beta = page.getByRole("checkbox", { name: "beta" }).element().closest('[role="row"]')!;
    expect(beta.querySelector("[data-hub-version]")).toBeNull();
    expect(beta.textContent).toContain("Server");
    await expect.element(page.getByText("\u2192 1.0.0", { exact: true })).toBeVisible();
    // MiddleTruncate marks a head it had to cut with data-overflow.
    const name = [...document.querySelectorAll<HTMLElement>('[role="cell"] [title]')].find(
      (element) => element.title === MAC,
    )!;
    await vi.waitFor(() => expect(name.querySelector("[data-overflow]")).toBeNull());
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  });
});
