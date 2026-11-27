import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { MemoryStrip } from "./MemoryStrip";
import "~/index.css";

const respond = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => {
  const original = await load<typeof import("@t3tools/client-runtime/state/runtime")>();
  const Atom = await import("effect/reactivity/Atom");
  return {
    ...original,
    createEnvironmentRpcCommand: (
      ...args: Parameters<typeof original.createEnvironmentRpcCommand>
    ) =>
      args[1].tag.startsWith("memory.")
        ? { permissionAtom: () => Atom.make(true) }
        : original.createEnvironmentRpcCommand(...args),
    runAtomCommand: respond,
  };
});

it("shows counts and storage disclosure only for an orchestrator", async () => {
  const environmentId = EnvironmentId.make("machine");
  respond.mockResolvedValueOnce({ _tag: "Success", value: null });
  await using _ordinary = await render(
    <MemoryStrip environmentId={environmentId} threadId={ThreadId.make("ordinary")} />,
  );
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  expect(page.getByText(/unencrypted/).query()).toBeNull();
  respond.mockResolvedValueOnce({ _tag: "Success", value: { total: 7, proposed: 2, disputed: 1 } });
  respond.mockResolvedValueOnce({ _tag: "Success", value: [] });
  await using _orchestrator = await render(
    <MemoryStrip environmentId={environmentId} threadId={ThreadId.make("orchestrator")} />,
  );
  await expect
    .element(
      page.getByRole("button", { name: /Memory.*7 notes.*Stored unencrypted on this machine/ }),
    )
    .toBeVisible();
});
