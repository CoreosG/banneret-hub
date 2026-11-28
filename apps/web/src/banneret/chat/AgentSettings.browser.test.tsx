import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AgentThreadHeader, AgentWakeSetting } from "./AgentSettings";
import { chatRpc } from "./client";
const { useEnterpriseFeed } = vi.hoisted(() => ({ useEnterpriseFeed: vi.fn() }));
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

vi.mock("../useEnterpriseFeed", () => ({ useEnterpriseFeed }));

it("shows waiting deliveries and saves the agent's wake choice", async () => {
  await commands.companyChat("wake:start");
  await using resources = new AsyncDisposableStack();
  resources.defer(() => commands.companyChat("wake:stop"));
  const env = EnvironmentId.make("desk");
  useEnterpriseFeed.mockReturnValue({
    environmentId: env,
    target: { environmentId: env, relayOrigin: "https://relay.test" },
    feed: {
      chatFlags: ["agents", "agent_inbox"],
      needs: [{ kind: "agent_inbox", handleId: "h_review", count: 3 }],
    },
  });
  using _rpc = vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const r = await commands.companyChat("wake:leo", action);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  });
  await using screen = await render(<AgentThreadHeader environmentId={env} thread="review1" />);
  await expect.element(screen.getByText("3 waiting")).toBeVisible();
  await expect.element(screen.getByText(/· Wake: /)).toBeVisible();
  await screen.getByText("3 waiting").click();
  await screen.getByLabelText("Who can wake this agent").selectOptions("owner");
  await screen.getByRole("button", { name: "Save" }).click();
  await vi.waitFor(async () =>
    expect(
      await commands.companyChat("wake:leo", { kind: "threadChat", thread: "review1" }),
    ).toMatchObject({ value: { wake: "owner" } }),
  );
});

it("sets the wake default in Settings and links to it from a thread when the relay has no agent handles", async () => {
  await commands.companyChat("wake:start");
  await using resources = new AsyncDisposableStack();
  resources.defer(() => commands.companyChat("wake:stop"));
  const env = EnvironmentId.make("desk");
  useEnterpriseFeed.mockReturnValue({
    environmentId: env,
    target: { environmentId: env, relayOrigin: "https://relay.test" },
    workspace: { name: "Engineering" },
    // What a relay with an agent inbox but no agent handles advertises.
    feed: { chatFlags: ["agent_inbox"] },
  });
  using rpc = vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const r = await commands.companyChat("wake:leo", action);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  });
  {
    await using header = await render(<AgentThreadHeader environmentId={env} thread="review1" />);
    await expect
      .element(header.getByRole("link", { name: "Wake settings" }))
      .toHaveAttribute("href", "/settings/chat#agent-wake");
  }
  await using screen = await render(<AgentWakeSetting />);
  await expect.element(screen.getByText("Who can wake your agents in Engineering")).toBeVisible();
  const select = screen.getByRole("combobox", { name: "Who can wake new agents" });
  await expect.element(select).toBeEnabled();
  await select.selectOptions("nobody");
  await expect.element(select).toHaveValue("nobody");
  await screen.getByRole("button", { name: "Apply to all my agents" }).click();
  await vi.waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(expect.anything(), { kind: "applyWake", wake: "nobody" }),
  );
});
