import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WorkspaceRoles } from "./Roles";
import { chatRpc } from "./client";

const { useEnterpriseFeed } = vi.hoisted(() => ({ useEnterpriseFeed: vi.fn() }));
vi.mock(import("~/environments/primary/target"), async (original) => ({
  ...(await original()),
  readPrimaryEnvironmentTarget: () => null,
}));

vi.mock("../../state/session", async (load) => ({
  ...(await load<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../useEnterpriseFeed", () => ({ useEnterpriseFeed }));
it("creates an outside role, assigns it, handles role_in_use, then deletes after reassignment", async () => {
  const { people } = await commands.companyChat("roles:start");
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => commands.companyChat("roles:stop"));
  using _rpc = vi.spyOn(chatRpc, "run").mockImplementation(async (_, action) => {
    const r = await commands.companyChat("roles:call", action);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  });
  const enterprise = {
    target: { environmentId: EnvironmentId.make("desk"), relayOrigin: "https://chat.test" },
    workspace: { id: "demo" },
    enrolment: { me: { permissions: ["relay.admin"] } },
    feed: { sections: ["roles"], team: { value: { people } } },
  };
  vi.mocked(useEnterpriseFeed).mockReturnValue(enterprise);
  await using screen = await render(<WorkspaceRoles />);
  const button = (name: string | RegExp) => screen.getByRole("button", { name });
  await button("Roles").click();
  await button("New role").click();
  const roleId = screen.getByLabelText("Role ID");
  await expect
    .element(screen.getByText(/lowercase letters, numbers and underscores/))
    .toBeVisible();
  await expect.element(roleId).toHaveAccessibleDescription(/No hyphens or spaces/);
  await roleId.fill("release-manager");
  expect((roleId.element() as HTMLInputElement).validity.patternMismatch).toBe(true);
  await roleId.fill("reviewer");
  await screen.getByLabelText("Role name").fill("Reviewer");
  await screen.getByLabelText("For outside collaborators").click();
  await expect.element(screen.getByLabelText("Administer relay")).toBeDisabled();
  await button("Save role").click();
  await button("Reviewer (0)").click();
  const member = people.find((p) => p.login === "leo")!;
  await screen.getByLabelText("Assign to person").fill(member.id);
  await button("Assign role").click();
  await expect.element(button("Reviewer (1)")).toBeVisible();
  await button(/^Founder \(/).click();
  const founders = people.filter((p) => p.role.id === "founder").map((p) => p.login);
  expect(founders.length).toBeGreaterThan(1);
  // Every holder by login, and no bare head count.
  await expect.element(screen.getByText(/^Changes apply to /)).toBeVisible();
  expect(screen.getByText(/^Changes apply to /).element().textContent).toBe(
    `Changes apply to ${founders.slice(0, -1).join(", ")} and ${founders.at(-1)}. Channel memberships stay as they are.`,
  );
  await button("Reviewer (1)").click();
  await button("Delete role").click();
  await expect
    .element(screen.getByText("Move members first. Built-in templates cannot be removed."))
    .toBeVisible();
  await button(/^Staff \(/).click();
  await screen.getByLabelText("Assign to person").fill(member.id);
  await button("Assign role").click();
  await button("Reviewer (0)").click();
  await button("Delete role").click();
  await expect.element(button("Reviewer (0)")).not.toBeInTheDocument();
});
