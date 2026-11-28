import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AgentThreadHeader, AgentWakeSetting } from "./AgentSettings";
import { AskSettings } from "./AskSettings";
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

it("offers no outside collaborator or their agent as an auto-accept rule", async () => {
  const handle = (id: string, login: string) => ({
    id: "h_" + id,
    owner: { id: "p_" + login, login },
    claimName: id,
    provider: "codex",
    machine: { id: "m_1", label: "Desk" },
    reachable: true,
    wake: "everyone",
    paused: false,
  });
  using _rpc = vi.spyOn(chatRpc, "run").mockImplementation(async () => ({
    items: [handle("builder", "ada"), handle("visitor", "olivia")],
    nextCursor: null,
  }));
  const env = EnvironmentId.make("desk");
  const person = (login: string, admission: "member" | "outside") => ({
    id: "p_" + login,
    login,
    admission,
    role: { id: admission === "member" ? "staff" : "outside", name: admission },
  });
  const enterprise = {
    environmentId: env,
    target: { environmentId: env, relayOrigin: "https://relay.test" },
    feed: { team: { value: { people: [person("ada", "member"), person("olivia", "outside")] } } },
  } as unknown as Parameters<typeof AskSettings>[0]["enterprise"];
  await using screen = await render(
    <AskSettings
      enterprise={enterprise}
      policy={{ default: "approve", auto: [], maxTokens: 200000, maxSeconds: 900 }}
      save={() => {}}
    />,
  );
  const subjects = screen.getByLabelText("Rule subject").getByRole("option");
  const labels = () => subjects.elements().map((option) => option.textContent);
  await expect.poll(labels).toEqual(["ada"]);
  await screen.getByRole("combobox", { name: /^From/ }).selectOptions("agent");
  await expect.poll(labels).toEqual(["ada/builder"]);
});
