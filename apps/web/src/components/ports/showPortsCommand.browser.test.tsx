import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { openPortsDialog, portsDialogEnvironmentAtom } from "~/state/banneretPorts";

import { useCommandPaletteShowPortsItem } from "./showPortsCommand";

const state = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<{
    environmentId: string;
    label: string;
    connection: { phase: string };
  }>,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironments: () => ({ isReady: true, environments: state.environments }),
}));

const environment = (id: string, label: string, phase = "connected") => ({
  environmentId: id,
  label,
  connection: { phase },
});

function NoThreadShowPorts() {
  const item = useCommandPaletteShowPortsItem({ panelRef: null });
  if (item === null) return <p>No Show ports</p>;
  const actions =
    item.kind === "submenu"
      ? item.groups.flatMap((group) => group.items)
      : [{ ...item, title: `Run ${item.title}` }];
  return (
    <ul data-kind={item.kind}>
      {actions.map((action) => (
        <li key={action.value}>
          <button
            type="button"
            onClick={() => (action.kind === "action" ? void action.run() : undefined)}
          >
            {action.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

describe("Show ports with no thread or draft", () => {
  it("asks which environment when several are connected, then opens the Ports dialog", async () => {
    openPortsDialog(null);
    state.environments = [
      environment("local", "This computer"),
      environment("paired", "Build box"),
      environment("offline", "Laptop", "disconnected"),
    ];
    await using screen = await render(<NoThreadShowPorts />);

    await expect.element(screen.getByRole("list")).toHaveAttribute("data-kind", "submenu");
    await expect.element(screen.getByRole("button", { name: "Laptop" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Build box" }));

    expect(appAtomRegistry.get(portsDialogEnvironmentAtom)).toBe(EnvironmentId.make("paired"));
  });

  it("opens the only connected environment's ports directly", async () => {
    openPortsDialog(null);
    state.environments = [environment("paired", "Build box")];
    await using screen = await render(<NoThreadShowPorts />);

    await expect.element(screen.getByRole("list")).toHaveAttribute("data-kind", "action");
    await userEvent.click(page.getByRole("button", { name: "Run Show ports" }));

    expect(appAtomRegistry.get(portsDialogEnvironmentAtom)).toBe(EnvironmentId.make("paired"));
  });

  it("is absent when no environment is connected", async () => {
    state.environments = [environment("offline", "Laptop", "disconnected")];
    await using screen = await render(<NoThreadShowPorts />);

    await expect.element(screen.getByText("No Show ports")).toBeVisible();
  });
});
