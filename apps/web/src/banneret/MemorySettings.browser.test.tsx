import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { MemorySettings } from "./MemorySettings";
import "~/index.css";

vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

vi.mock("../components/settings/SettingsScopeContext", async (load) => ({
  ...(await load<typeof import("../components/settings/SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "all" },
    connectedEnvironments: [
      { environmentId: "local", label: "Local" },
      { environmentId: "remote", label: "Remote" },
    ],
  }),
}));

const respond = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => {
  const original = await load<typeof import("@t3tools/client-runtime/state/runtime")>();
  const Atom = await import("effect/reactivity/Atom");
  return {
    ...original,
    createEnvironmentRpcCommand: (
      ...args: Parameters<typeof original.createEnvironmentRpcCommand>
    ) =>
      args[1].tag === "memory.setSetting"
        ? { permissionAtom: () => Atom.make(true) }
        : original.createEnvironmentRpcCommand(...args),
    runAtomCommand: respond,
  };
});

it("changes only the selected environment and preserves its switch on a failed write", async () => {
  respond.mockResolvedValue({ _tag: "Success", value: false });
  await using screen = await render(<MemorySettings />);
  const remote = screen.getByRole("switch", { name: "Use Banneret memory on Remote" });
  const local = screen.getByRole("switch", { name: "Use Banneret memory on Local" });
  await expect.element(remote).toBeEnabled();
  respond.mockResolvedValueOnce({ _tag: "Success", value: true });
  await remote.click();
  await expect.element(remote).toBeChecked();
  await expect.element(local).not.toBeChecked();
  expect(respond.mock.lastCall?.[2]).toEqual({ environmentId: "remote", input: { enabled: true } });
  respond.mockResolvedValueOnce({ _tag: "Failure" });
  await remote.click();
  await expect.element(screen.getByText("Could not save memory setting.")).toBeVisible();
  await expect.element(remote).toBeChecked();
});

it("renders the rows that settings search jumps to", async () => {
  respond.mockResolvedValue({ _tag: "Success", value: false });
  await using screen = await render(<MemorySettings />);
  for (const id of ["automatic-work", "agent-wake"])
    expect(document.getElementById(id)).not.toBeNull();
  await expect.element(screen.getByRole("button", { name: "Stop all" }).first()).toBeVisible();
  await expect.element(screen.getByText("Who can wake your agents")).toBeVisible();
});
