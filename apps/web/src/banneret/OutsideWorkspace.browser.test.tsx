import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { OutsideNotice } from "./OutsideWorkspace";

vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

const view = {
  workspaceId: "ent-rosa",
  relayOrigin: "https://relay.test",
  me: {
    id: "rosa",
    login: "rosa-dev",
    role: { id: "outside", name: "Outside" },
    admission: "outside",
    permissions: [],
  },
} as const;

it("identifies the outside workspace and signed-in account", async () => {
  await using screen = await render(<OutsideNotice view={{ ...view, state: "configured" }} />);
  await expect.element(screen.getByText("Outside collaborator", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Signed in as rosa-dev/)).toBeVisible();
});

it.each([
  ["outside_grant_lost", "repository"],
  ["outside_entry_removed", "outside collaborator list"],
  ["outside_2fa_off", "two-factor"],
  ["outside_identity_mismatch", "network account"],
])("explains %s for the account whose access ended", async (reason, words) => {
  await using screen = await render(
    <OutsideNotice
      view={{
        workspaceId: view.workspaceId,
        relayOrigin: view.relayOrigin,
        state: "revoked",
        refusedLogin: "rosa-dev",
        reason,
      }}
    />,
  );
  const alert = screen.getByRole("alert").element();
  expect(alert.textContent).toContain("rosa-dev");
  expect(alert.textContent).toContain(words);
});

it("keeps the signed-in account visible while GitHub access is checked again", async () => {
  await using screen = await render(
    <OutsideNotice
      view={{
        ...view,
        state: "configured",
        health: "outside_check_pending",
        lastOkAt: "2026-11-27T15:00:00Z",
      }}
    />,
  );
  expect(screen.getByRole("status").element().textContent).toContain(
    "Signed in as rosa-dev. GitHub access could not be checked. Retrying. Last checked",
  );
});
