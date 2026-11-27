import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { AccountsSettings } from "./AccountsSettings";
import { useEnrolmentStore, enrolmentRpc } from "./enrolmentStore";

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
            me: { login: "ada", role: "founder" },
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
