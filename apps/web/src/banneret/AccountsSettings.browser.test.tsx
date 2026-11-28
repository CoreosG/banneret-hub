import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useWorkspacesStore } from "./workspacesStore";
import { AccountsSettings } from "./AccountsSettings";
import { useEnrolmentStore, enrolmentRpc } from "./enrolmentStore";

vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

vi.mock("../state/environments", async (load) => ({
  ...(await load<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => "desk",
}));
vi.mock("./accountIdentity", async (load) => ({
  ...(await load<typeof import("./accountIdentity")>()),
  useGitHubLogin: (id: string) => ({ desk: "Ada", laptop: "bo" })[id as "desk" | "laptop"] ?? null,
}));

it("shows each connected machine's accounts and its comparison with each relay", async () => {
  const machines = ["desk", "laptop", "server"].map((label) => ({
    environmentId: EnvironmentId.make(label),
    label,
  }));
  useEnrolmentStore.setState({
    views: Object.fromEntries(
      machines.map(({ label }) => [
        label,
        [
          {
            state: "configured",
            workspaceId: "example",
            relayOrigin: "https://relay.example",
            label,
            me: {
              login: "ada",
              id: "p_me",
              permissions: ["relay.admin"],
              role: { id: "founder", name: "Founder" },
              admission: "member" as const,
            },
          },
        ],
      ]),
    ),
  });
  const tailscale = vi
    .spyOn(enrolmentRpc, "tailscaleLogin")
    .mockResolvedValue({ ok: true, value: "ada@example.com" });
  await using screen = await render(<AccountsSettings machines={machines} />);
  await expect.element(screen.getByText("Tailscale: ada@example.com")).toBeVisible();
  await expect.element(screen.getByText("GitHub account matches")).toBeVisible();
  await expect.element(screen.getByText("GitHub account differs from relay")).toBeVisible();
  await expect.element(screen.getByText("GitHub: Not available")).toBeVisible();
  expect(tailscale.mock.calls).toEqual([["desk"]]);
});

it("opens the named company's join from the Workspace roles search target", async () => {
  const workspace = {
    id: "ent-example",
    name: "Company A",
    kind: "enterprise" as const,
    relay: { origin: "https://company-a.example", displayName: "Company A" },
    projectKeys: [],
    updatedAt: "2026-11-28T00:00:00Z",
  };
  useEnrolmentStore.setState({ views: {} });
  useWorkspacesStore.setState({ local: [workspace], activeId: workspace.id, dialog: null });
  using reset = new DisposableStack();
  reset.defer(() => useWorkspacesStore.setState({ local: [], activeId: null, dialog: null }));
  await using screen = await render(<AccountsSettings machines={[]} />);
  await expect.element(screen.getByText("Join Company A to manage roles")).toBeVisible();
  await screen.getByRole("button", { name: "Join", exact: true }).click();
  expect(useWorkspacesStore.getState().dialog).toMatchObject({
    kind: "enterprise",
    origin: workspace.relay.origin,
  });
});
