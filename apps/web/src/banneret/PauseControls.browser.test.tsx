import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { PauseControls, usePause } from "./Pause";

const respond = vi.hoisted(() => vi.fn());
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => {
  const original = await load<typeof import("@t3tools/client-runtime/state/runtime")>();
  const Atom = await import("effect/reactivity/Atom");
  return {
    ...original,
    createEnvironmentRpcCommand: (
      ...args: Parameters<typeof original.createEnvironmentRpcCommand>
    ) =>
      args[1].tag.startsWith("banneretPause.")
        ? { tag: args[1].tag, permissionAtom: () => Atom.make(true) }
        : original.createEnvironmentRpcCommand(...args),
    runAtomCommand: respond,
  };
});

it("pauses new work in one click and asks before Stop all", async () => {
  const id = EnvironmentId.make("machine");
  usePause.setState({ [id]: { status: { paused: false, held: 0, running: [] } } });
  respond.mockResolvedValue({ _tag: "Success", value: { paused: true, held: 0, running: [] } });
  await using screen = await render(<PauseControls id={id} size="xs" />);
  const actions = () => respond.mock.calls.map((call) => call[2].input);
  await screen.getByRole("button", { name: "Stop all" }).click();
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(actions()).toEqual([]);
  await screen.getByRole("button", { name: "Stop all" }).click();
  await screen.getByRole("button", { name: "Stop everything" }).click();
  await expect.element(screen.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(actions()).toEqual([{ kind: "stopAll" }]);
  await screen.getByRole("button", { name: "Resume" }).click();
  expect(actions().at(-1)).toEqual({ kind: "resume" });
});
